// Load CSS
if (!document.getElementById('wmmCss')) {
    var link = document.createElement('link');
    link.id = 'wmmCss';
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = 'css/web_mods_ui.css';
    document.head.appendChild(link);
}

//=============================================================================
// web_mods_ui.js
// Mod manager for the OMORI web port.
//
// Lets players install mods from the browser: drop or pick a mod .zip (or an
// extracted mod folder). Files are written into the localStorage-backed
// virtual filesystem under <game>/mods/<name>/, which OneLoader scans on the
// next boot - so after an install, reload and the mod is recognized like any
// disk mod (mod.json, plugins, assets, asyncExec, ... all work).
//
// Also exposes window.WebModManager for console/scripting use:
//   WebModManager.listMods()              -> [{folder, json, bytes}]
//   WebModManager.removeMod(folder)       -> deletes an uploaded mod
//   WebModManager.installZipBytes(u8, name)   (async)
//   WebModManager.installEntries(entries, label)  entries: [{path, data:Uint8Array}]
//   WebModManager.storageInfo()           -> {used, quota, percent}
//
// Note: mods are stored in IndexedDB (no practical size limit; the browser
// only prompts for very large origins). Saves and config stay in the smaller
// localStorage pool, so big mods never crowd out save data. If IndexedDB is
// blocked (rare/private modes) installs fall back to localStorage, which does
// have the classic ~5MB ceiling.
//=============================================================================
(function() {
    'use strict';

    if (window.WebModManager) { return; }

    var LS_PREFIX = 'omori_web_fs:';
    var fs = null, pp = null;
    try { fs = require('fs'); pp = require('path'); } catch (e) { return; }
    if (!fs || !fs.writeFileSync || !pp || !pp.join) { return; }

    //-----------------------------------------------------------------------
    // Boot gate.
    //
    // The mod manager is the first thing the player sees: modloader/
    // early_loader.js awaits window.__webBootGate at the top of run(), before
    // it scans mods and boots the game. The "Start game" button resolves it,
    // so anything installed while gated is picked up by the scan with no
    // reload. If this script cannot initialise we never create the gate and
    // the game boots normally instead of hanging forever.
    //-----------------------------------------------------------------------
    var gatePending = false;
    var gateResolve = null;
    if (!window.__webBootGate) {
        gatePending = true;
        window.__webBootGate = new Promise(function(resolve) { gateResolve = resolve; });
    }
    window.__webStartGame = function() {
        if (!gatePending) { return; }
        gatePending = false;
        try {
            // move the panel back out of the gate and make it a floating panel
            var panel = document.getElementById('wmmPanel');
            if (panel && panel.parentNode !== document.body) {
                document.body.appendChild(panel);
                panel.style.position = 'fixed';
                panel.style.top = '40px';
                panel.style.right = '8px';
                panel.style.width = '340px';
                panel.style.maxWidth = '';
                panel.style.maxHeight = '80vh';
                panel.style.display = 'none';
            }
            var gate = document.getElementById('wmmGate');
            if (gate && gate.parentNode) { gate.parentNode.removeChild(gate); }
            var toggle = document.getElementById('wmmToggle');
            if (toggle) { toggle.style.display = ''; }
            if (window.$oneLoaderGui && $oneLoaderGui.container) { $oneLoaderGui.container.style.display = ''; }
        } catch (e) { /* never let cleanup stop the boot */ }
        if (gateResolve) { gateResolve(); }
    };

    var BASE = location.href.split('#')[0].split('?')[0].replace(/[^\/]*$/, '');
    var MODS_PATH = pp.join(BASE, 'mods'); // absolute URL, no trailing slash
    var MODS_KEY_PREFIX = LS_PREFIX + MODS_PATH + '/';

    //-----------------------------------------------------------------------
    // small helpers
    //-----------------------------------------------------------------------
    function utf8Encode(str) {
        return new TextEncoder().encode(str);
    }
    function utf8Decode(u8) {
        return new TextDecoder().decode(u8);
    }
    function b64ToU8(b64) {
        var bin = atob(b64);
        var u8 = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) { u8[i] = bin.charCodeAt(i); }
        return u8;
    }
    function decodeStoredString(v) {
        // matches web_compat's encodeForStorage: binaries are "b64:..."-prefixed
        if (typeof v === 'string' && v.indexOf('b64:') === 0) { return b64ToU8(v.slice(4)); }
        return utf8Encode(String(v));
    }
    function sanitizeFolderName(name) {
        name = String(name || 'mod').replace(/\.[^.]*$/, ''); // strip extension
        name = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/_+/g, '_')
                    .replace(/^[._-]+/, '').slice(0, 40);
        if (!name) { name = 'mod'; }
        return 'web_' + name; // '_' prefix is skipped by OneLoader, so keep web_
    }
    function isJunkPath(segments) {
        for (var i = 0; i < segments.length; i++) {
            var s = segments[i];
            if (s === '__MACOSX' || s === '.DS_Store' || s === 'Thumbs.db') { return true; }
            if (s.charAt(0) === '.' && s !== '.') { return true; }
        }
        return false;
    }

    //-----------------------------------------------------------------------
    // zip reading (minimal central-directory parser + DecompressionStream)
    //-----------------------------------------------------------------------
    function inflateRaw(bytes) {
        if (typeof DecompressionStream === 'undefined') {
            return Promise.reject(new Error('This browser has no DecompressionStream - cannot extract deflated zips.'));
        }
        var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(stream).arrayBuffer().then(function(ab) { return new Uint8Array(ab); });
    }

    function unzip(u8) {
        try { return unzipInner(u8); } catch (e) { return Promise.reject(e); }
    }

    function unzipInner(u8) {
        var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        // locate End Of Central Directory record (0x06054b50), scanning back from the end
        var eocd = -1;
        var stop = Math.max(0, u8.length - 66000);
        for (var i = u8.length - 22; i >= stop; i--) {
            if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) { return Promise.reject(new Error('Not a valid zip file (no end-of-central-directory record).')); }
        var count = dv.getUint16(eocd + 10, true);
        var cdOffset = dv.getUint32(eocd + 16, true);
        if (count === 0xffff || cdOffset === 0xffffffff) {
            return Promise.reject(new Error('Zip64 archives are not supported.'));
        }

        var tasks = [];
        var p = cdOffset;
        for (var n = 0; n < count; n++) {
            if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) {
                return Promise.reject(new Error('Corrupt zip central directory.'));
            }
            var flags = dv.getUint16(p + 8, true);
            var method = dv.getUint16(p + 10, true);
            var compSize = dv.getUint32(p + 20, true);
            var nameLen = dv.getUint16(p + 28, true);
            var extraLen = dv.getUint16(p + 30, true);
            var commentLen = dv.getUint16(p + 32, true);
            var localOff = dv.getUint32(p + 42, true);
            var name = utf8Decode(u8.subarray(p + 46, p + 46 + nameLen));
            p += 46 + nameLen + extraLen + commentLen;

            if (flags & 0x1) { return Promise.reject(new Error('Encrypted zip entries are not supported: ' + name)); }
            if (compSize === 0xffffffff || name.length === 0) { return Promise.reject(new Error('Zip64 archives are not supported.')); }
            if (name.charAt(name.length - 1) === '/') { continue; } // directory entry

            if (localOff + 30 > u8.length || dv.getUint32(localOff, true) !== 0x04034b50) {
                return Promise.reject(new Error('Corrupt zip local header for ' + name));
            }
            var lnameLen = dv.getUint16(localOff + 26, true);
            var lextLen = dv.getUint16(localOff + 28, true);
            var dataStart = localOff + 30 + lnameLen + lextLen;
            if (dataStart + compSize > u8.length) {
                return Promise.reject(new Error('Truncated zip entry data for ' + name));
            }
            var raw = u8.subarray(dataStart, dataStart + compSize);

            if (method === 0) {
                tasks.push({ name: name, data: Promise.resolve(raw.slice()) });
            } else if (method === 8) {
                tasks.push({ name: name, data: inflateRaw(raw) });
            } else {
                return Promise.reject(new Error('Unsupported compression method ' + method + ' for ' + name));
            }
        }

        return Promise.all(tasks.map(function(t) {
            return t.data.then(function(d) { return { path: t.name, data: d }; });
        }));
    }

    //-----------------------------------------------------------------------
    // install pipeline
    //-----------------------------------------------------------------------
    // entries: [{path, data: Uint8Array}] -> written under mods/<folder>/
    function installEntries(entries, label) {
        // 1) sanitize paths
        var clean = [];
        for (var i = 0; i < entries.length; i++) {
            var rel = String(entries[i].path || '').replace(/\\/g, '/').replace(/^\.\//, '');
            var segs = rel.split('/');
            var good = [];
            var ok = true;
            for (var s = 0; s < segs.length; s++) {
                var seg = segs[s];
                if (seg === '' || seg === '.') { continue; }
                if (seg === '..') { ok = false; break; }
                good.push(seg);
            }
            if (!ok || good.length === 0 || isJunkPath(good)) { continue; }
            clean.push({ segments: good, data: entries[i].data });
        }
        if (clean.length === 0) { throw new Error('No usable files found.'); }

        // 2) find the shallowest mod.json - its directory is the mod root
        var best = null;
        for (var j = 0; j < clean.length; j++) {
            var c = clean[j];
            if (c.segments[c.segments.length - 1].toLowerCase() !== 'mod.json') { continue; }
            var depth = c.segments.length - 1;
            if (best === null || depth < best) { best = depth; }
        }
        if (best === null) { throw new Error('No mod.json found - this does not look like an OneLoader mod.'); }

        // 3) flatten: strip the mod root directory from every path
        //    (handles "mod.zip", "MyMod/mod.zip" and folder-picker layouts)
        var rootSegs = [];
        if (best > 0) {
            for (var r = 0; r < clean.length; r++) {
                var cr = clean[r];
                if (cr.segments.length - 1 === best && cr.segments[best].toLowerCase() === 'mod.json') {
                    rootSegs = cr.segments.slice(0, best);
                    break;
                }
            }
        }
        var files = [];
        for (var k = 0; k < clean.length; k++) {
            var segs2 = clean[k].segments;
            if (best > 0) {
                if (segs2.length <= best) { continue; }
                var matches = true;
                for (var d = 0; d < best; d++) {
                    if (segs2[d] !== rootSegs[d]) { matches = false; break; }
                }
                if (!matches) { continue; }
                segs2 = segs2.slice(best);
            }
            if (segs2.length === 0) { continue; }
            files.push({ path: segs2.join('/'), data: clean[k].data });
        }
        if (files.length === 0) { throw new Error('Mod contains no files.'); }

        // verify mod.json parses
        var jsonEntry = null;
        for (var q = 0; q < files.length; q++) {
            if (files[q].path.toLowerCase() === 'mod.json') { jsonEntry = files[q]; break; }
        }
        if (!jsonEntry) { throw new Error('No mod.json found after flattening.'); }
        var jsonText = (typeof jsonEntry.data === 'string') ? jsonEntry.data : utf8Decode(jsonEntry.data);
        var modJson;
        try { modJson = JSON.parse(jsonText); } catch (e) { throw new Error('mod.json is not valid JSON: ' + e.message); }

        // 4) target folder under mods/
        var folder = sanitizeFolderName(label || (modJson.name || modJson.id || 'mod'));
        var targetPrefix = MODS_KEY_PREFIX + folder + '/';

        // 5) stage key/bytes pairs, then persist to IndexedDB - no localStorage
        //    5MB ceiling here, mods can be arbitrarily large. Memory gets the
        //    files synchronously (instant reads) and IDB makes them durable.
        var pairs = [];
        var bytes = 0;
        for (var w = 0; w < files.length; w++) {
            var data = files[w].data;
            if (typeof data === 'string') { data = utf8Encode(data); }
            bytes += data.length;
            pairs.push({ key: LS_PREFIX + pp.join(MODS_PATH, folder, files[w].path), u8: data });
        }
        var spill = window.__webFsSpill;
        if (!spill) {
            return Promise.reject(new Error('Persistent mod storage is unavailable in this browser.'));
        }
        var result = { folder: folder, files: files.length, bytes: bytes, json: modJson };

        function writeViaLocalStorage() {
            // legacy fallback: IDB blocked (private browsing etc.) - small mods
            // may still fit in localStorage
            try {
                removeByPrefix(targetPrefix);
                for (var li = 0; li < pairs.length; li++) {
                    fs.writeFileSync(pairs[li].key.slice(LS_PREFIX.length), pairs[li].u8);
                }
                return result;
            } catch (e) {
                var m = String(e && e.message || e);
                if ((e && e.name === 'QuotaExceededError') || /quota/i.test(m)) {
                    throw new Error('This browser blocked IndexedDB and localStorage is full - cannot store a ' + bytes + '-byte mod.');
                }
                throw e;
            }
        }

        return Promise.resolve(window.__webFsHydration).then(function(hydrated) {
            if (!hydrated) { return writeViaLocalStorage(); }
            return removeByPrefix(targetPrefix).then(function() {
                for (var i2 = 0; i2 < pairs.length; i2++) { spill.put(pairs[i2].key, pairs[i2].u8); }
                return spill.persist(pairs);
            }).then(function() {
                return result;
            }, function(err) {
                // roll back staged files; the IDB transaction is atomic, so a
                // failed persist left nothing durable behind
                return removeByPrefix(targetPrefix).then(function() { return null; }, function() { return null; })
                    .then(function() {
                        var msg = String(err && err.message || err);
                        if ((err && err.name === 'QuotaExceededError') || /quota/i.test(msg)) {
                            throw new Error('Not enough storage space for this mod (' + bytes + ' bytes). Free disk space for this site and try again.');
                        }
                        throw new Error('Could not save the mod: ' + msg);
                    });
            });
        });
    }

    function installZipBytes(u8, zipName) {
        return unzip(u8).then(function(entries) {
            return installEntries(entries, String(zipName || 'mod.zip').replace(/\.zip$/i, ''));
        });
    }

    function removeByPrefix(prefix) {
        // sync part: legacy localStorage keys + in-memory cache
        var spill = window.__webFsSpill;
        var toRemove = [];
        for (var i = localStorage.length - 1; i >= 0; i--) {
            var k = localStorage.key(i);
            if (k && k.indexOf(prefix) === 0) { toRemove.push(k); }
        }
        if (spill && spill.memFiles) {
            for (var mk in spill.memFiles) {
                if (Object.prototype.hasOwnProperty.call(spill.memFiles, mk) && mk.indexOf(prefix) === 0) {
                    toRemove.push(mk);
                }
            }
        }
        for (var j = 0; j < toRemove.length; j++) {
            localStorage.removeItem(toRemove[j]);
            if (spill) { delete spill.memFiles[toRemove[j]]; }
        }
        // async part: durable IndexedDB entries
        if (!spill || !spill.removePrefix) { return Promise.resolve(toRemove.length); }
        return spill.removePrefix(prefix).catch(function() { return toRemove.length; });
    }

    //-----------------------------------------------------------------------
    // introspection
    //-----------------------------------------------------------------------
    function listMods() {
        var byFolder = {};
        function addFile(key, rest, size, decode) {
            var slash = rest.indexOf('/');
            if (slash <= 0) { return; }
            var folder = rest.slice(0, slash);
            var rec = byFolder[folder];
            if (!rec) { rec = byFolder[folder] = { folder: folder, json: null, bytes: 0, fileCount: 0 }; }
            rec.bytes += size;
            rec.fileCount++;
            if (rest.slice(slash + 1).toLowerCase() === 'mod.json') {
                try { rec.json = JSON.parse(decode()); } catch (e) { rec.json = { name: '(invalid mod.json)' }; }
            }
        }
        // legacy localStorage layer
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (!k || k.indexOf(MODS_KEY_PREFIX) !== 0) { continue; }
            var v = localStorage.getItem(k);
            addFile(k, k.slice(MODS_KEY_PREFIX.length), k.length + (v ? v.length : 0),
                (function(val) { return function() { return utf8Decode(decodeStoredString(val)); }; })(v));
        }
        // IndexedDB-backed layer (in-memory cache)
        var spill = window.__webFsSpill;
        if (spill && spill.memFiles) {
            for (var mk in spill.memFiles) {
                if (!Object.prototype.hasOwnProperty.call(spill.memFiles, mk)) { continue; }
                if (mk.indexOf(MODS_KEY_PREFIX) !== 0) { continue; }
                if (localStorage.getItem(mk) !== null) { continue; } // legacy copy wins
                addFile(mk, mk.slice(MODS_KEY_PREFIX.length), mk.length + spill.memFiles[mk].length,
                    (function(u8) { return function() { return utf8Decode(u8); }; })(spill.memFiles[mk]));
            }
        }
        var out = [];
        for (var f in byFolder) { if (Object.prototype.hasOwnProperty.call(byFolder, f)) { out.push(byFolder[f]); } }
        out.sort(function(a, b) { return a.folder < b.folder ? -1 : 1; });
        return out;
    }

    function removeMod(folder) {
        return removeByPrefix(MODS_KEY_PREFIX + folder + '/');
    }

    function storageInfo() {
        var lsUsed = 0;
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (!k || k.indexOf(LS_PREFIX) !== 0) { continue; }
            var v = localStorage.getItem(k);
            lsUsed += k.length + (v ? v.length : 0);
        }
        var modBytes = 0;
        var spill = window.__webFsSpill;
        if (spill && spill.memFiles) {
            for (var mk in spill.memFiles) {
                if (Object.prototype.hasOwnProperty.call(spill.memFiles, mk)) {
                    modBytes += mk.length + spill.memFiles[mk].length;
                }
            }
        }
        var used = lsUsed + modBytes;
        var quota = 100 * 1024 * 1024; // fallback until the async estimate lands
        var info = {
            used: used, lsUsed: lsUsed, modBytes: modBytes,
            quota: quota, percent: Math.min(100, Math.round(used / quota * 100))
        };
        if (navigator.storage && navigator.storage.estimate) {
            navigator.storage.estimate().then(function(est) {
                if (est && est.quota) {
                    info.quota = est.quota;
                    info.percent = Math.min(100, Math.round(info.used / est.quota * 100));
                    if (ui.storageEl) { renderStorage(info); }
                }
            }).catch(function() {});
        }
        return info;
    }

    //-----------------------------------------------------------------------
    // drag & drop collection
    //-----------------------------------------------------------------------
    function collectEntry(entry, prefix, out) {
        return new Promise(function(resolve) {
            if (entry.isFile) {
                entry.file(function(f) {
                    out.push({ path: prefix + f.name, data: null, file: f });
                    resolve();
                }, function() { resolve(); });
            } else if (entry.isDirectory) {
                var reader = entry.createReader();
                var all = [];
                var readBatch = function() {
                    reader.readEntries(function(batch) {
                        if (batch.length === 0) {
                            Promise.all(all.map(function(e2) { return collectEntry(e2, prefix + entry.name + '/', out); })).then(resolve, resolve);
                        } else {
                            all = all.concat(Array.prototype.slice.call(batch));
                            readBatch();
                        }
                    }, function() { resolve(); });
                };
                readBatch();
            } else {
                resolve();
            }
        });
    }

    function filesFromDataTransfer(dt) {
        var items = dt.items ? Array.prototype.slice.call(dt.items) : [];
        var entries = [];
        if (items.length > 0 && items[0].webkitGetAsEntry) {
            var pending = items.map(function(it) {
                var e = it.webkitGetAsEntry();
                return e ? collectEntry(e, '', entries) : Promise.resolve();
            });
            return Promise.all(pending).then(function() { return entries; });
        }
        var files = dt.files ? Array.prototype.slice.call(dt.files) : [];
        return Promise.resolve(files.map(function(f) {
            return { path: f.webkitRelativePath || f.name, data: null, file: f };
        }));
    }

    function materialize(entries) {
        // fill in data from File objects where needed
        return Promise.all(entries.map(function(e) {
            if (e.data) { return e; }
            if (!e.file) { return e; }
            return e.file.arrayBuffer().then(function(ab) {
                return { path: e.path, data: new Uint8Array(ab) };
            });
        }));
    }

    //-----------------------------------------------------------------------
    // DOM UI
    //-----------------------------------------------------------------------
    var ui = { panelEl: null, listEl: null, statusEl: null, storageEl: null, toggleEl: null };

    function fmtBytes(n) {
        if (n < 1024) { return n + ' B'; }
        if (n < 1024 * 1024) { return (n / 1024).toFixed(1) + ' KB'; }
        return (n / (1024 * 1024)).toFixed(2) + ' MB';
    }

    function setStatus(msg, isError) {
        if (!ui.statusEl) { return; }
        ui.statusEl.textContent = msg || '';
        ui.statusEl.style.color = isError ? '#ff8080' : '#9fef9f';
    }

    function renderStorage(info) {
        if (!ui.storageEl) { return; }
        ui.storageEl.innerHTML = '';
        var bar = document.createElement('div');
        bar.style.cssText = 'height:8px;background:#111;border:1px solid #555;border-radius:4px;overflow:hidden;';
        var fill = document.createElement('div');
        fill.style.cssText = 'height:100%;width:' + info.percent + '%;background:' + (info.percent > 85 ? '#d33' : '#4a9');
        bar.appendChild(fill);
        var label = document.createElement('div');
        label.style.cssText = 'font-size:11px;color:#aaa;margin-top:3px;';
        label.textContent = 'Saves/config: ' + fmtBytes(info.lsUsed || 0) + ' - Mods: ' +
            fmtBytes(info.modBytes || 0) + ' (' + info.percent + '% of browser quota)';
        ui.storageEl.appendChild(bar);
        ui.storageEl.appendChild(label);
    }

    function renderList() {
        if (!ui.listEl) { return; }
        ui.listEl.innerHTML = '';
        var mods = listMods();
        var head = document.createElement('div');
        head.style.cssText = 'font-size:12px;color:#aaa;margin:6px 0 3px;';
        head.textContent = mods.length ? 'Uploaded mods (stored in this browser):' : 'No uploaded mods yet.';
        ui.listEl.appendChild(head);
        for (var i = 0; i < mods.length; i++) {
            (function(mod) {
                var row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:6px;background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:4px 6px;margin-bottom:4px;';
                var text = document.createElement('div');
                text.style.cssText = 'flex:1;min-width:0;font-size:12px;';
                var name = (mod.json && (mod.json.name || mod.json.id)) || mod.folder;
                var version = (mod.json && mod.json.version) ? ' v' + mod.json.version : '';
                text.textContent = name + version + ' (' + mod.fileCount + ' files, ' + fmtBytes(mod.bytes) + ')';
                text.title = mod.folder;
                var del = document.createElement('button');
                del.textContent = 'Delete';
                del.style.cssText = 'background:#522;color:#faa;border:1px solid #733;border-radius:3px;cursor:pointer;font-size:11px;padding:2px 8px;';
                del.addEventListener('click', function() {
                    if (confirm('Delete "' + name + '"?')) {
                        removeMod(mod.folder);
                        setStatus('Removed ' + name + '. Reload to apply.');
                        renderList();
                        renderStorage(storageInfo());
                    }
                });
                row.appendChild(text);
                row.appendChild(del);
                ui.listEl.appendChild(row);
            })(mods[i]);
        }
    }

    function handleFiles(entries, label) {
        setStatus('Installing...');
        materialize(entries).then(function(filled) {
            var zipLike = filled.length === 1 && /\.zip$/i.test(filled[0].path) && filled[0].data;
            if (zipLike) {
                return installZipBytes(filled[0].data, filled[0].path);
            }
            return installEntries(filled, label);
        }).then(function(res) {
            setStatus('Installed "' + (res.json && res.json.name || res.folder) + '" (' + res.files + ' files). Click "Reload game" to play with it.');
            renderList();
            renderStorage(storageInfo());
        }).catch(function(err) {
            setStatus('Install failed: ' + (err && err.message || err), true);
            renderList();
        });
    }

    function el(tag, style, parent) {
        var e = document.createElement(tag);
        if (style) { e.style.cssText = style; }
        if (parent) { parent.appendChild(e); }
        return e;
    }

    function el(tag, style, parent) {
        var e = document.createElement(tag);
        if (style) { e.style.cssText = style; }
        if (parent) { parent.appendChild(e); }
        return e;
    }

    function mountGate() {
        if (!gatePending || !document.body || !ui.panelEl) { return; }
        if (document.getElementById('wmmGate')) { return; }

        var Z = '2147483647';
        // hide the OneLoader splash + the floating toggle while gated
        try { if (window.$oneLoaderGui && $oneLoaderGui.container) { $oneLoaderGui.container.style.display = 'none'; } } catch (e) {}
        ui.toggleEl.style.display = 'none';

        var gate = el('div',
            'position:fixed;top:0;left:0;right:0;bottom:0;z-index:' + Z + ';overflow-y:auto;' +
            'background:radial-gradient(circle at 50% 28%, #14141d 0%, #04040a 72%);' +
            'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px 0;' +
            "font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;color:#eee;", document.body);
        gate.id = 'wmmGate';

        var logo = el('div', 'font-size:24px;font-weight:900;letter-spacing:1px;color:#8fd0ff;', gate);
        logo.textContent = 'OMORI Web Port';
        var sub = el('div', 'font-size:12px;color:#9ab;margin:4px 0 12px;', gate);
        sub.textContent = 'web port by turg';

        // park the manager panel inside the gate, always open and centered
        gate.appendChild(ui.panelEl);
        ui.panelEl.style.position = 'static';
        ui.panelEl.style.top = '';
        ui.panelEl.style.right = '';
        ui.panelEl.style.width = '440px';
        ui.panelEl.style.maxWidth = '92vw';
        ui.panelEl.style.maxHeight = '70vh';
        ui.panelEl.style.display = 'block';

        var startBtn = el('button',
            'margin-top:14px;background:#1d5c86;color:#fff;border:1px solid #4aa3dd;border-radius:5px;' +
            'padding:10px 30px;font-size:15px;font-weight:600;cursor:pointer;', gate);
        startBtn.id = 'wmmStart';
        startBtn.textContent = '\u25B6 Start game';
        startBtn.addEventListener('click', function() { window.__webStartGame(); });

        var note = el('div', 'font-size:11px;color:#7788;margin-top:8px;max-width:460px;text-align:center;', gate);
        note.textContent = 'Mod support is currently in beta, so don\'t be surprised if a mod is broken in the web build.';

        gate.addEventListener('keydown', function(ev) {
            if (ev.key === 'Enter') { ev.preventDefault(); window.__webStartGame(); }
        });

        // refresh once IndexedDB mods have been hydrated into memory
        if (window.__webFsHydration && window.__webFsHydration.then) {
            window.__webFsHydration.then(function() {
                renderList();
                renderStorage(storageInfo());
            }, function() {});
        }
    }

    function initUi() {
        if (ui.panelEl || !document.body) { return; }

        var Z = '2147483647';
        ui.toggleEl = el('button',
            'position:fixed;top:8px;right:8px;z-index:' + Z + ';background:rgba(10,10,14,0.85);color:#8fd0ff;' +
            'border:1px solid #3a5a7a;border-radius:4px;padding:5px 10px;font-size:13px;cursor:pointer;' +
            "font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;user-select:none;", document.body);
        ui.toggleEl.id = 'wmmToggle';
        ui.toggleEl.textContent = 'MODS';
        ui.toggleEl.title = 'Open the web port mod manager';

        ui.panelEl = el('div',
            'position:fixed;top:40px;right:8px;z-index:' + Z + ';width:340px;max-height:80vh;overflow-y:auto;' +
            'background:rgba(12,12,16,0.96);color:#eee;border:1px solid #3a5a7a;border-radius:6px;padding:10px;' +
            "font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;font-size:13px;display:none;", document.body);
        ui.panelEl.id = 'wmmPanel';

        var title = el('div', 'font-size:14px;font-weight:bold;margin-bottom:6px;color:#8fd0ff;', ui.panelEl);
        title.textContent = 'Mod Manager';

        var drop = el('div',
            'border:2px dashed #446;border-radius:5px;padding:14px 8px;text-align:center;color:#9ab;' +
            'margin-bottom:8px;cursor:pointer;transition:background 0.15s;', ui.panelEl);
        drop.textContent = 'Drop a mod .zip (or mod folder) here';
        drop.addEventListener('dragover', function(ev) { ev.preventDefault(); drop.style.background = '#182838'; });
        drop.addEventListener('dragleave', function() { drop.style.background = ''; });
        drop.addEventListener('drop', function(ev) {
            ev.preventDefault();
            drop.style.background = '';
            filesFromDataTransfer(ev.dataTransfer).then(function(entries) {
                if (entries.length === 0) { setStatus('Nothing to install.', true); return; }
                handleFiles(entries, null);
            });
        });

        var btnRow = el('div', 'display:flex;gap:6px;margin-bottom:8px;', ui.panelEl);
        var zipInput = el('input', 'display:none;', ui.panelEl);
        zipInput.type = 'file';
        zipInput.accept = '.zip,application/zip';
        zipInput.multiple = true;
        var dirInput = el('input', 'display:none;', ui.panelEl);
        dirInput.type = 'file';
        dirInput.webkitdirectory = true;
        dirInput.multiple = true;

        function mkBtn(labelText, parent) {
            var b = el('button',
                'flex:1;background:#182838;color:#cde;border:1px solid #3a5a7a;border-radius:4px;' +
                'padding:5px 4px;cursor:pointer;font-size:12px;', parent);
            b.textContent = labelText;
            return b;
        }
        var zipBtn = mkBtn('Install .zip...', btnRow);
        var dirBtn = mkBtn('Install folder...', btnRow);
        zipBtn.addEventListener('click', function() { zipInput.click(); });
        dirBtn.addEventListener('click', function() { dirInput.click(); });
        zipInput.addEventListener('change', function() {
            var files = Array.prototype.slice.call(zipInput.files || []);
            zipInput.value = '';
            if (files.length === 0) { return; }
            handleFiles(files.map(function(f) { return { path: f.name, data: null, file: f }; }), null);
        });
        dirInput.addEventListener('change', function() {
            var files = Array.prototype.slice.call(dirInput.files || []);
            dirInput.value = '';
            if (files.length === 0) { return; }
            handleFiles(files.map(function(f) { return { path: f.webkitRelativePath || f.name, data: null, file: f }; }), null);
        });

        ui.statusEl = el('div', 'font-size:12px;margin-bottom:6px;min-height:16px;white-space:pre-wrap;', ui.panelEl);
        ui.storageEl = el('div', 'margin-bottom:6px;', ui.panelEl);
        ui.listEl = el('div', 'margin-bottom:8px;', ui.panelEl);

        var bottomRow = el('div', 'display:flex;gap:6px;', ui.panelEl);
        var reloadBtn = mkBtn('Reload game', bottomRow);
        reloadBtn.addEventListener('click', function() { location.reload(); });
        var closeBtn = mkBtn('Close', bottomRow);
        closeBtn.addEventListener('click', function() { ui.panelEl.style.display = 'none'; });

        // keep keystrokes inside the panel from reaching the game (arrow keys
        // would otherwise move the title menu underneath)
        ui.panelEl.addEventListener('keydown', function(ev) { ev.stopPropagation(); }, true);
        ui.panelEl.addEventListener('keyup', function(ev) { ev.stopPropagation(); }, true);

        ui.toggleEl.addEventListener('click', function() {
            var open = ui.panelEl.style.display !== 'none';
            ui.panelEl.style.display = open ? 'none' : 'block';
            if (!open) {
                renderList();
                renderStorage(storageInfo());
                setStatus('');
            }
        });

        // prevent the browser from opening dropped files as a page when they
        // land outside the drop zone
        window.addEventListener('dragover', function(ev) { ev.preventDefault(); });
        window.addEventListener('drop', function(ev) { ev.preventDefault(); });

        // the mod manager comes up before the game boots
        mountGate();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUi);
    } else {
        initUi();
    }

    window.WebModManager = {
        listMods: listMods,
        removeMod: removeMod,
        installZipBytes: installZipBytes,
        installEntries: installEntries,
        storageInfo: storageInfo,
        modsPath: MODS_PATH,
        openPanel: function() {
            if (!ui.panelEl) { initUi(); }
            if (!ui.panelEl) { return; }
            ui.panelEl.style.display = 'block';
            renderList();
            renderStorage(storageInfo());
            setStatus('');
        }
    };
})();

