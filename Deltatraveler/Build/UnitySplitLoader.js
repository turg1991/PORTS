/*
 * UnitySplitLoader.js
 *
 * Rebuilds oversized Unity WebGL build assets that were split on disk by
 * tools/split-build-files.mjs into the single byte stream Unity expects.
 *
 * UnityLoader.downloadJob normally issues one GET for a build file and pipes the
 * response through UnityLoader.Compression.decompress. This wrapper intercepts
 * only the URLs listed in the split index; every other download is delegated to
 * the original implementation untouched. The reassembled bytes are handed back
 * to Unity unmodified, so Unity's own gzip/brotli detection and UnityWebData
 * parsing behave exactly as they did before the file was split.
 *
 * Must be loaded after Build/UnityLoader.js and before UnityLoader.instantiate.
 * Await UnitySplitLoader.ready(indexUrl) before instantiating.
 */
(function (global) {
  'use strict';

  /* How many parts to download at once. Also bounds extra memory use. */
  var CONCURRENT_PARTS = 3;

  /* Set to true to re-hash every reassembled file against its manifest entry.
     Requires a secure context (https or localhost) for crypto.subtle. */
  var VERIFY_CHECKSUMS = false;

  var splitIndex = null;
  var originalDownloadJob = null;
  var installError = null;

  function stripQueryAndHash(url) {
    var text = String(url);
    var cut = text.search(/[?#]/);
    return cut === -1 ? text : text.slice(0, cut);
  }

  function baseName(url) {
    var text = stripQueryAndHash(url).replace(/\\/g, '/');
    return text.slice(text.lastIndexOf('/') + 1);
  }

  function directoryOf(url) {
    var text = stripQueryAndHash(url).replace(/\\/g, '/');
    return text.slice(0, text.lastIndexOf('/') + 1);
  }

  function lookupEntry(url) {
    if (!splitIndex || !splitIndex.files) return null;
    var name = baseName(url);
    return Object.prototype.hasOwnProperty.call(splitIndex.files, name)
      ? splitIndex.files[name]
      : null;
  }

  /* UnityLoader.Progress.update reads `type`, `lengthComputable`, `total` and
     `loaded` off the event, so synthesised events must carry all four. */
  function reportProgress(params, type, loaded, total) {
    var handler = type === 'load' ? params.onload : params.onprogress;
    if (typeof handler !== 'function') return;
    handler({ type: type, lengthComputable: true, loaded: loaded, total: total });
  }

  function fatal(message, err) {
    var detail = err && err.message ? err.message : String(err);
    if (global.console && console.error) console.error('[UnitySplitLoader] ' + message, err);
    if (global.alert) global.alert('[UnitySplitLoader] ' + message + '\n\n' + detail);
  }

  function fetchPart(url, part) {
    return fetch(url, { cache: 'force-cache' })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('HTTP ' + response.status + ' ' + response.statusText + ' for ' + url);
        }
        return response.arrayBuffer();
      })
      .then(function (buffer) {
        var bytes = new Uint8Array(buffer);
        if (typeof part.size === 'number' && bytes.length !== part.size) {
          throw new Error(url + ': expected ' + part.size + ' bytes, received ' + bytes.length);
        }
        return bytes;
      });
  }

  /*
   * Writes each part into its exact slot of one pre-allocated buffer. Building a
   * single output buffer (instead of concatenating arrays) keeps the peak
   * allocation close to what Unity's own XHR would have used.
   */
  function mergeParts(baseUrl, entry, onProgress) {
    var parts = entry.parts;
    var total = entry.size;

    var offsets = new Array(parts.length);
    var running = 0;
    for (var i = 0; i < parts.length; i++) {
      offsets[i] = running;
      running += parts[i].size;
    }
    if (running !== total) {
      return Promise.reject(
        new Error(entry.name + ': parts total ' + running + ' bytes but manifest declares ' + total)
      );
    }

    var out = new Uint8Array(total);
    var loaded = 0;
    var cursor = 0;
    var failed = false;

    function worker() {
      if (failed || cursor >= parts.length) return Promise.resolve();
      var index = cursor++;
      var part = parts[index];
      return fetchPart(baseUrl + part.name, part).then(function (bytes) {
        if (failed) return;
        out.set(bytes, offsets[index]);
        loaded += bytes.length;
        onProgress(loaded, total);
        return worker();
      });
    }

    var workers = [];
    var width = Math.min(CONCURRENT_PARTS, parts.length);
    for (var w = 0; w < width; w++) workers.push(worker());

    return Promise.all(workers).then(function () {
      return out;
    });
  }

  function verifyChecksum(bytes, entry) {
    if (!VERIFY_CHECKSUMS || !entry.sha256) return Promise.resolve(bytes);
    var subtle = global.crypto && global.crypto.subtle;
    if (!subtle) {
      if (global.console && console.warn) {
        console.warn('[UnitySplitLoader] crypto.subtle unavailable; skipping checksum verification');
      }
      return Promise.resolve(bytes);
    }
    return subtle.digest('SHA-256', bytes).then(function (digest) {
      var hex = Array.prototype.map
        .call(new Uint8Array(digest), function (b) {
          return ('0' + b.toString(16)).slice(-2);
        })
        .join('');
      if (hex !== entry.sha256) {
        throw new Error(entry.name + ': checksum mismatch, expected ' + entry.sha256 + ' got ' + hex);
      }
      return bytes;
    });
  }

  function rebuildFromParts(job, params, entry, baseUrl) {
    reportProgress(params, 'progress', 0, entry.size);

    mergeParts(baseUrl, entry, function (loaded, total) {
      reportProgress(params, 'progress', loaded, total);
    })
      .then(function (bytes) {
        return verifyChecksum(bytes, entry);
      })
      .then(function (bytes) {
        /* Same call UnityLoader.downloadJob makes, on the same bytes it would
           have received had the file never been split. */
        global.UnityLoader.Compression.decompress(bytes, function (decompressed) {
          reportProgress(params, 'load', entry.size, entry.size);
          job.complete(decompressed);
        });
      })['catch'](function (err) {
        fatal('Failed to rebuild ' + entry.name + ' from ' + entry.parts.length + ' parts.', err);
      });
  }

  function install() {
    if (originalDownloadJob) return;

    if (
      typeof global.UnityLoader !== 'object' ||
      global.UnityLoader === null ||
      typeof global.UnityLoader.downloadJob !== 'function'
    ) {
      installError = new Error(
        'UnityLoader.downloadJob was not found - load Build/UnityLoader.js before Build/UnitySplitLoader.js'
      );
      return;
    }

    originalDownloadJob = global.UnityLoader.downloadJob;

    global.UnityLoader.downloadJob = function (module, job) {
      var params = job && job.parameters;
      var entry = params ? lookupEntry(params.url) : null;

      /* No entry means the file was not split: behave exactly as before.
         objParameters means UnityLoader's IndexedDB cache is in charge. */
      if (!entry || params.objParameters) {
        return originalDownloadJob.apply(this, arguments);
      }

      rebuildFromParts(job, params, entry, directoryOf(params.url));
    };
  }

  /*
   * Loads the split index and installs the downloadJob wrapper. Resolves with the
   * index, or with null when there is no index - in which case Unity loads build
   * files directly, exactly as an unsplit build would.
   */
  function ready(indexUrl) {
    install();

    if (installError) {
      if (global.console && console.warn) console.warn('[UnitySplitLoader] ' + installError.message);
      return Promise.resolve(null);
    }

    var url = indexUrl || 'Build/parts-index.json';

    return fetch(url, { cache: 'no-cache' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
        return response.json();
      })
      .then(function (index) {
        splitIndex = index;
        var count = index && index.files ? Object.keys(index.files).length : 0;
        if (global.console && console.info) {
          console.info('[UnitySplitLoader] ' + count + ' split file(s) registered.');
        }
        return index;
      })['catch'](function (err) {
        splitIndex = null;
        if (global.console && console.warn) {
          console.warn(
            '[UnitySplitLoader] no split index (' + err.message + '); build files will be downloaded directly.'
          );
        }
        return null;
      });
  }

  global.UnitySplitLoader = {
    ready: ready,
    version: '1.0.0',
  };
})(window);
