//=============================================================================
// web_compat.js
// Browser compatibility layer for running the OMORI web/playtest build from a
// plain static HTTP server (no NW.js / Node / Steam available).
//
// - Provides window.process, require('fs'|'path'|'os'|'crypto'|'nw.gui'|...),
//   window.nw and a greenworks/Steam stub so plugins that call Node APIs at
//   load time do not crash.
// - fs is backed by HTTP for game assets (case-corrected through
//   window.WEB_FILE_MANIFEST) and by localStorage for writable paths
//   (saves, config, permanent cutscene data).
// - All asset URLs (XHR, fetch, <img>/<video>/<audio> src) are re-cased to
//   the real on-disk file name so the game also works on case-sensitive
//   web servers.
//=============================================================================
(function() {
    'use strict';

    var MANIFEST = window.WEB_FILE_MANIFEST || {};
    var LS_PREFIX = 'omori_web_fs:';

    var PAGE_URL = location.href.split('#')[0].split('?')[0];
    var BASE_URL = PAGE_URL.replace(/[^\/]*$/, ''); // directory of index.html

    //-------------------------------------------------------------------------
    // URL / path helpers
    //-------------------------------------------------------------------------
    function isUrl(s) {
        return /^[a-z][a-z0-9+.-]*:/i.test(s);
    }

    function stripSuffix(s) {
        return String(s).split('#')[0].split('?')[0];
    }

    function originOf(url) {
        var m = /^([a-z][a-z0-9+.-]*:\/\/[^\/]*)/i.exec(url);
        return m ? m[1] : '';
    }

    function basePathOf(url) {
        var m = /^([a-z][a-z0-9+.-]*:\/\/[^\/]*)(\/.*)?$/i.exec(url);
        if (!m) { return '/'; }
        var rest = m[2] || '/';
        rest = rest.replace(/\/+$/, '');
        return rest + '/';
    }

    // Collapse duplicate slashes and resolve ./ and .. segments.
    function normalizeRest(rest) {
        rest = String(rest).replace(/\/{2,}/g, '/');
        var segs = rest.split('/');
        var out = [];
        for (var i = 0; i < segs.length; i++) {
            var seg = segs[i];
            if (seg === '.' || seg === '') { continue; }
            if (seg === '..') {
                if (out.length > 0 && out[out.length - 1] !== '..') { out.pop(); }
                else { out.push('..'); }
                continue;
            }
            out.push(seg);
        }
        var trailing = /\/$/.test(rest) && out.length > 0;
        return '/' + out.join('/') + (trailing ? '/' : '');
    }

    function normalizeAny(p) {
        p = stripSuffix(String(p));
        var m = /^([a-z][a-z0-9+.-]*:\/\/[^\/]*)(\/.*)?$/i.exec(p);
        if (m) {
            return m[1] + normalizeRest(m[2] || '/');
        }
        if (isUrl(p)) { return p; }
        if (p.charAt(0) === '/') { return normalizeRest(p); }
        return normalizeRest('/' + p).slice(1);
    }

    // Resolve any referenced path to an absolute URL (game assets) or an
    // absolute virtual path (localStorage-backed writable paths).
    function toAbs(p) {
        p = stripSuffix(String(p));
        if (isUrl(p)) { return normalizeAny(p); }
        if (p.charAt(0) === '/') { return normalizeAny(p); } // virtual (localStorage-backed) path
        if (/^www\//i.test(p)) { return normalizeAny(BASE_URL + p.slice(4)); }
        return normalizeAny(BASE_URL + p);
    }

    // Look the path up in the manifest (case-insensitive); returns a
    // fetchable URL with the real on-disk casing, or null when unknown.
    function resolveAsset(abs) {
        if (!isUrl(abs)) { return null; }
        var origin = originOf(abs);
        var rest = abs.slice(origin.length);
        rest = decodeURIPath(normalizeRest(rest));
        var basePath = basePathOf(BASE_URL);
        var key = rest;
        var base = basePath.toLowerCase();
        var k = key.toLowerCase();
        if (base !== '/' && k.indexOf(base) === 0) {
            key = key.slice(basePath.length);
        }
        key = key.replace(/^\/+/, '');
        var lower = key.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(MANIFEST, lower)) {
            // Re-encode: real filenames may contain literal '%' (e.g. "$DW_OMORI_RUN%(8).png"),
            // which must go over the wire as %25 or strict servers reject the URL.
            return BASE_URL + MANIFEST[lower].split('/').map(encodeURIComponent).join('/');
        }
        return null;
    }

    function decodeURIPath(p) {
        try { return decodeURIComponent(p); } catch (e) { return p; }
    }

    function canonicalUrl(p) {
        var abs = toAbs(p);
        if (!isUrl(abs)) { return abs; }
        return resolveAsset(abs) || abs;
    }

    // A DirectoryMod's "filesystem" dataSource stores a raw on-disk path
    // (e.g. C:\...\www\mods\reverie\img\system\IconSet.png). In the browser that
    // literal path isn't fetchable; the file is served over HTTP via the manifest,
    // which maps the lowercase relative key -> real on-disk casing. Given a raw
    // disk path, find the longest trailing segment-suffix that is a manifest key
    // and return the canonical URL (so overlay binary assets like mod IconSet.png
    // resolve to the real file instead of a mangled URL that yields garbage bytes).
    // Returns null when no manifest entry matches (caller falls back to toAbs).
    function resolveDiskPath(p) {
        var s = String(p);
        // A Windows drive path (C:\... or C:/...) matches the "scheme:" shape of
        // isUrl, so detect it explicitly BEFORE the isUrl bail-out.
        var isWinDrive = /^[a-z]:[\\\/]/i.test(s);
        if (!isWinDrive) {
            if (isUrl(s)) { return null; }
            if (!/[\\\/]/.test(s)) { return null; }
        }
        var norm = s.replace(/\\/g, '/').toLowerCase();
        var segs = norm.split('/').filter(Boolean);
        for (var start = 0; start < segs.length; start++) {
            var suffix = segs.slice(start).join('/');
            if (Object.prototype.hasOwnProperty.call(MANIFEST, suffix)) {
                var real = MANIFEST[suffix];
                return BASE_URL + real.split('/').map(encodeURIComponent).join('/');
            }
        }
        return null;
    }

    //-------------------------------------------------------------------------
    // process / os / path / crypto / nw shims
    //-------------------------------------------------------------------------
    var processShim = {
        argv: ['test'],
        versions: { nw: '0.44.0' },
        env: {
            LOCALAPPDATA: '/webdata',
            APPDATA: '/webdata',
            HOME: '/webdata',
            USERPROFILE: '/webdata'
        },
        platform: 'win32', // Node exposes process.platform as a string; plugins compare with ===
        nextTick: function(fn) { setTimeout(fn, 0); },
        mainModule: { filename: BASE_URL + 'index.html' },
        cwd: function() { return BASE_URL.replace(/\/+$/, ''); },
        exit: function() {}
    };
    window.process = processShim;
    window.global = window;

    function pathDirname(p) {
        p = stripSuffix(String(p));
        var m = /^([a-z][a-z0-9+.-]*:\/\/[^\/]*)(\/.*)?$/i.exec(p);
        if (m) {
            var rest = (m[2] || '/').replace(/\/+$/, '');
            var idx = rest.lastIndexOf('/');
            if (idx <= 0) { return m[1] + '/'; }
            return m[1] + rest.slice(0, idx);
        }
        if (p.charAt(0) === '/') {
            var r = p.replace(/\/+$/, '');
            var i = r.lastIndexOf('/');
            if (i <= 0) { return '/'; }
            return r.slice(0, i);
        }
        var s = p.replace(/\/+$/, '');
        var j = s.lastIndexOf('/');
        if (j < 0) { return '.'; }
        return s.slice(0, j) || '/';
    }

    function pathBasename(p, ext) {
        p = stripSuffix(String(p)).replace(/\/+$/, '');
        var base = p.slice(p.lastIndexOf('/') + 1);
        if (ext && base.length > ext.length && base.slice(base.length - ext.length) === ext) {
            base = base.slice(0, base.length - ext.length);
        }
        return base;
    }

    function pathExtname(p) {
        var base = pathBasename(p);
        var idx = base.lastIndexOf('.');
        return idx > 0 ? base.slice(idx) : '';
    }

    function pathJoin() {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
            var part = String(arguments[i]);
            if (part === '') { continue; }
            parts.push(part);
        }
        if (parts.length === 0) { return '.'; }
        var joined = parts.join('/');
        var m = /^([a-z][a-z0-9+.-]*:\/\/[^\/]*)/i.exec(joined);
        if (m) {
            return m[1] + normalizeRest(joined.slice(m[1].length));
        }
        if (joined.charAt(0) === '/') { return normalizeRest(joined); }
        return normalizeRest('/' + joined).slice(1);
    }

    var pathShim = {
        sep: '/',
        delimiter: ':',
        dirname: pathDirname,
        basename: pathBasename,
        extname: pathExtname,
        join: pathJoin,
        normalize: function(p) { return normalizeAny(p); },
        resolve: function() {
            var resolved = '';
            for (var i = arguments.length - 1; i >= 0 && resolved === ''; i--) {
                resolved = toAbs(arguments[i]);
            }
            return normalizeAny(resolved);
        },
        isAbsolute: function(p) { return isUrl(p) || String(p).charAt(0) === '/'; },
        relative: function(from, to) { return toAbs(to); }
    };

    var osShim = {
        platform: function() { return 'win32'; },
        arch: function() { return 'x64'; },
        type: function() { return 'Windows_NT'; },
        homedir: function() { return '/webdata'; },
        tmpdir: function() { return '/webdata'; },
        EOL: '\n',
        userInfo: function() { return { username: 'player', homedir: '/webdata' }; }
    };

    //-------------------------------------------------------------------------
    // Byte helpers + WebBuffer (Node Buffer stand-in)
    //-------------------------------------------------------------------------
    function utf8Encode(s) { return new TextEncoder().encode(s); }
    function utf8Decode(u8) { return new TextDecoder('utf-8').decode(u8); }
    function hexOf(u8) {
        var s = '';
        for (var i = 0; i < u8.length; i++) {
            var h = u8[i].toString(16);
            s += h.length < 2 ? '0' + h : h;
        }
        return s;
    }
    function b64Encode(u8) {
        var s = '';
        for (var i = 0; i < u8.length; i += 0x8000) {
            s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        }
        return btoa(s);
    }
    function b64Decode(str) {
        var bin = atob(str);
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
        return out;
    }

    function WebBuffer(data) {
        if (data === undefined || data === null) { this._u8 = new Uint8Array(0); }
        else if (data instanceof WebBuffer) { this._u8 = data._u8; }
        else if (typeof data === 'string') { this._u8 = utf8Encode(data); }
        else if (data instanceof ArrayBuffer) { this._u8 = new Uint8Array(data); }
        else if (ArrayBuffer.isView(data)) { this._u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength); }
        else { this._u8 = new Uint8Array(data); }
        this.length = this._u8.length;
    }
    WebBuffer.from = function(data, encoding) {
        if (encoding === 'base64') { return new WebBuffer(b64Decode(String(data))); }
        if (encoding === 'hex') {
            var s = String(data);
            var out = new Uint8Array(Math.floor(s.length / 2));
            for (var i = 0; i < out.length; i++) { out[i] = parseInt(s.substr(i * 2, 2), 16); }
            return new WebBuffer(out);
        }
        return new WebBuffer(data);
    };
    WebBuffer.concat = function(list) {
        var parts = [], total = 0, i;
        for (i = 0; i < list.length; i++) {
            var u8 = (list[i] instanceof WebBuffer) ? list[i]._u8 : new WebBuffer(list[i])._u8;
            parts.push(u8);
            total += u8.length;
        }
        var out = new Uint8Array(total), off = 0;
        for (i = 0; i < parts.length; i++) { out.set(parts[i], off); off += parts[i].length; }
        return new WebBuffer(out);
    };
    WebBuffer.prototype.toString = function(encoding) {
        encoding = (encoding || 'utf8').toLowerCase();
        if (encoding === 'base64') { return b64Encode(this._u8); }
        if (encoding === 'hex') { return hexOf(this._u8); }
        return utf8Decode(this._u8);
    };
    WebBuffer.prototype.slice = function(start, end) {
        return new WebBuffer(this._u8.slice(
            start === undefined ? 0 : start,
            end === undefined ? this._u8.length : end
        ));
    };
    window.Buffer = WebBuffer;

    //-------------------------------------------------------------------------
    // sha256 + crypto with createHash('sha256') + randomBytes
    //-------------------------------------------------------------------------
    function rotr32(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }
    function sha256Bytes(bytes) {
        var K = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        ];
        var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
        var len = bytes.length;
        var padded = new Uint8Array((((len + 8) >> 6) + 1) * 64);
        padded.set(bytes);
        padded[len] = 0x80;
        var bitLen = len * 8;
        var view = new DataView(padded.buffer);
        view.setUint32(padded.length - 4, bitLen >>> 0, false);
        view.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296), false);
        var w = new Uint32Array(64);
        for (var off = 0; off < padded.length; off += 64) {
            var i;
            for (i = 0; i < 16; i++) { w[i] = view.getUint32(off + i * 4, false); }
            for (i = 16; i < 64; i++) {
                var s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
                var s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
                w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
            }
            var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
            for (var j = 0; j < 64; j++) {
                var S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
                var ch = (e & f) ^ (~e & g);
                var t1 = (h + S1 + ch + K[j] + w[j]) >>> 0;
                var S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
                var maj = (a & b) ^ (a & c) ^ (b & c);
                var t2 = (S0 + maj) >>> 0;
                h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
            }
            H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
            H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
        }
        var out = new Uint8Array(32);
        var ov = new DataView(out.buffer);
        for (var k = 0; k < 8; k++) { ov.setUint32(k * 4, H[k], false); }
        return out;
    }
    function bytesWrapper(u8) {
        return {
            _u8: u8,
            length: u8.length,
            toString: function(enc) {
                if (enc === 'base64') { return b64Encode(u8); }
                if (enc === 'utf8' || enc === 'utf-8') { return utf8Decode(u8); }
                return hexOf(u8);
            }
        };
    }

    var cryptoShim = {
        randomBytes: function(n) {
            var buf = new Uint8Array(n);
            window.crypto.getRandomValues(buf);
            return bytesWrapper(buf);
        },
        createHash: function(alg) {
            if (String(alg).toLowerCase() !== 'sha256') {
                throw new Error('crypto.createHash: only sha256 is available in the web build');
            }
            var chunks = [];
            return {
                update: function(d) {
                    if (d instanceof WebBuffer) { chunks.push(d._u8); }
                    else if (typeof d === 'string') { chunks.push(utf8Encode(d)); }
                    else if (d instanceof ArrayBuffer) { chunks.push(new Uint8Array(d)); }
                    else if (ArrayBuffer.isView(d)) { chunks.push(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)); }
                    return this;
                },
                digest: function(enc) {
                    var h = sha256Bytes(WebBuffer.concat(chunks)._u8);
                    return (enc === 'base64') ? b64Encode(h) : hexOf(h);
                }
            };
        },
        createDecipheriv: function() { throw new Error('crypto.createDecipheriv is not available in the web build'); },
        createCipheriv: function() { throw new Error('crypto.createCipheriv is not available in the web build'); },
        createDecipher: function() { throw new Error('crypto.createDecipher is not available in the web build'); },
        createCipher: function() { throw new Error('crypto.createCipher is not available in the web build'); }
    };
    try {
        if (window.crypto && !window.crypto.randomBytes) {
            window.crypto.randomBytes = function(n) { return cryptoShim.randomBytes(n); };
        }
    } catch (e) { /* ignore */ }

    //-------------------------------------------------------------------------
    // chrome.debugger no-op (OneLoader's chrome VFS probe)
    //-------------------------------------------------------------------------
    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || { lastError: null, reload: function() {} };
    window.chrome.debugger = {
        getTargets: function(cb) { cb([]); },
        attach: function(t, v, cb) { if (cb) { cb(); } },
        detach: function(t, cb) { if (cb) { cb(); } },
        sendCommand: function() {},
        onEvent: { addListener: function() {} }
    };

    //-------------------------------------------------------------------------
    // util / zlib / events / stream stubs (OneLoader + rollup ecosystem)
    //-------------------------------------------------------------------------
    var utilShim = {
        promisify: function(fn) {
            var self = this;
            return function() {
                var args = Array.prototype.slice.call(arguments);
                return new Promise(function(resolve, reject) {
                    args.push(function(err, result) {
                        if (err) { reject(err); } else { resolve(result); }
                    });
                    try { fn.apply(self, args); } catch (e) { reject(e); }
                });
            };
        },
        inherits: function(ctor, superCtor) {
            ctor.prototype = Object.create(superCtor.prototype || {});
            ctor.prototype.constructor = ctor;
        },
        inspect: function(o) { return String(o); },
        deprecate: function(fn) { return fn; }
    };

    //-------------------------------------------------------------------------
    // zlib, backed by pako (vendored at js/libs/pako.min.js).
    //
    // OneLoader compresses several things with zlib and reads them back:
    //   - delta patched files (stage2.js: zlib.deflateSync -> inflateSync)
    //   - parser output (early_loader.js) and image deltas (imagedelta_applier)
    //   - the OneLoader assistant's embedded base64 payload, and raw zip streams.
    // A throwing stub here made stage2 silently skip *every* delta patch, so
    // any mod that ships .jsond/.ymld/.jsd deltas (very common) had its maps,
    // database and plugin patches dropped ("... files will remain vanilla").
    //-------------------------------------------------------------------------
    function zlibImpl() {
        var p = (typeof window !== 'undefined' && window.pako) || (typeof pako !== 'undefined' && pako) || null;
        if (!p || typeof p.deflate !== 'function') {
            throw new Error('zlib is not available in the web build (js/libs/pako.min.js did not load)');
        }
        return p;
    }
    function zlibBytes(data) {
        if (data === undefined || data === null) { return new Uint8Array(0); }
        if (data instanceof WebBuffer) { return data._u8; }
        if (typeof data === 'string') { return utf8Encode(data); }
        if (data instanceof ArrayBuffer) { return new Uint8Array(data); }
        if (ArrayBuffer.isView(data)) { return new Uint8Array(data.buffer, data.byteOffset, data.byteLength); }
        return new Uint8Array(data);
    }
    function zlibOpts(options) {
        if (!options || typeof options !== 'object') { return {}; }
        var o = {};
        for (var k in options) {
            if (Object.prototype.hasOwnProperty.call(options, k)) { o[k] = options[k]; }
        }
        return o;
    }
    function zlibSync(kind, data, options) {
        var p = zlibImpl();
        var u8 = zlibBytes(data);
        var o = zlibOpts(options);
        var out;
        if (kind === 'deflate') { out = p.deflate(u8, o); }
        else if (kind === 'deflateRaw') { out = p.deflateRaw(u8, o); }
        else if (kind === 'gzip') { out = p.gzip(u8, o); }
        else if (kind === 'gunzip') { out = p.ungzip(u8, o); }
        else if (kind === 'inflateRaw') { out = p.inflateRaw(u8, o); }
        else if (kind === 'inflate') {
            try { out = p.inflate(u8, o); }
            catch (e) {
                // Tolerate raw-deflate streams (node's inflate() auto-detects too).
                try { out = p.inflateRaw(u8); }
                catch (e2) { throw e; }
            }
        }
        return new WebBuffer(out);
    }
    function zlibAsync(kind, d, o, cb) {
        if (typeof o === 'function') { cb = o; o = null; }
        setTimeout(function() {
            try { cb(null, zlibSync(kind, d, o)); }
            catch (e) { cb(e, null); }
        }, 0);
    }
    var zlibShim = {
        inflateSync: function(d, o) { return zlibSync('inflate', d, o); },
        inflateRawSync: function(d, o) { return zlibSync('inflateRaw', d, o); },
        deflateSync: function(d, o) { return zlibSync('deflate', d, o); },
        deflateRawSync: function(d, o) { return zlibSync('deflateRaw', d, o); },
        gzipSync: function(d, o) { return zlibSync('gzip', d, o); },
        gunzipSync: function(d, o) { return zlibSync('gunzip', d, o); },
        inflate: function(d, o, cb) { zlibAsync('inflate', d, o, cb); },
        inflateRaw: function(d, o, cb) { zlibAsync('inflateRaw', d, o, cb); },
        deflate: function(d, o, cb) { zlibAsync('deflate', d, o, cb); },
        deflateRaw: function(d, o, cb) { zlibAsync('deflateRaw', d, o, cb); },
        gzip: function(d, o, cb) { zlibAsync('gzip', d, o, cb); },
        gunzip: function(d, o, cb) { zlibAsync('gunzip', d, o, cb); }
    };

    function EventEmitterShim() { this._events = {}; }
    EventEmitterShim.prototype.on = EventEmitterShim.prototype.addListener = function(ev, fn) {
        (this._events[ev] = this._events[ev] || []).push(fn);
        return this;
    };
    EventEmitterShim.prototype.once = function(ev, fn) {
        var self = this;
        function wrapper() { self.removeListener(ev, wrapper); fn.apply(self, arguments); }
        wrapper.listener = fn;
        return this.on(ev, wrapper);
    };
    EventEmitterShim.prototype.emit = function(ev) {
        var args = Array.prototype.slice.call(arguments, 1);
        var list = this._events[ev];
        if (!list || !list.length) { return false; }
        for (var i = 0; i < list.length; i++) { list[i].apply(this, args); }
        return true;
    };
    EventEmitterShim.prototype.removeListener = function(ev, fn) {
        var list = this._events[ev];
        if (!list) { return this; }
        this._events[ev] = list.filter(function(f) { return f !== fn && f.listener !== fn; });
        return this;
    };
    EventEmitterShim.prototype.removeAllListeners = function(ev) {
        if (ev) { delete this._events[ev]; } else { this._events = {}; }
        return this;
    };
    EventEmitterShim.prototype.setMaxListeners = function() { return this; };
    var eventsShim = { EventEmitter: EventEmitterShim };

    function StreamStub() { EventEmitterShim.call(this); }
    StreamStub.prototype = Object.create(EventEmitterShim.prototype);
    StreamStub.prototype.constructor = StreamStub;
    StreamStub.prototype.pipe = function(dest) { return dest; };
    var streamShim = {
        Stream: StreamStub,
        Readable: StreamStub,
        Writable: StreamStub,
        Transform: StreamStub,
        PassThrough: StreamStub
    };

    function StreamZipStub() { throw new Error('Zip mods are not supported in the web build of OneLoader.'); }
    StreamZipStub.async = StreamZipStub;

    //-------------------------------------------------------------------------
    // NW.js / Steam shims
    //-------------------------------------------------------------------------
    function makeWindowStub() {
        return {
            x: 0, y: 0, menu: null, isFullscreen: false,
            on: function() {}, once: function() {}, removeAllListeners: function() {},
            focus: function() {}, show: function() {}, hide: function() {},
            moveTo: function() {}, moveBy: function() {},
            resizeTo: function() {}, resizeBy: function() {},
            setResizable: function() {}, setMinimumSize: function() {}, setMaximumSize: function() {},
            showDevTools: function() { return null; }, closeDevTools: function() {},
            leaveFullscreen: function() {}, toggleFullscreen: function() {},
            close: function() {}, reload: function() {}, reloadIgnoringCache: function() {},
            setProgressBar: function() {}, setBadgeLabel: function() {},
            requestAttention: function() {}
        };
    }

    var winStub = makeWindowStub();

    var nwGuiShim = {
        App: {
            argv: ['test'],
            dataPath: '',
            quit: function() {},
            closeWin: function() {},
            clearCache: function(cb) { if (cb) { cb(); } },
            getCrashDumpPath: function() { return ''; },
            getCookies: function(url, cb) { if (cb) { cb([]); } },
            setProxy: function() {}
        },
        Window: {
            get: function() { return winStub; },
            getAll: function() { return [winStub]; }
        },
        Shell: {
            openExternal: function() {},
            openItem: function() {},
            showItemInFolder: function() {}
        },
        Screen: {
            Init: function() {}, init: function() {}, on: function() {}, screencacheLimit: function() {}
        },
        Menu: function() {
            return { append: function() {}, createMacBuiltin: function() {}, remove: function() {} };
        },
        Tray: function() { return { on: function() {}, setToolTip: function() {}, remove: function() {} }; }
    };
    window.nw = nwGuiShim;

    var greenworksStub = {
        initAPI: function() { return false; },
        init: function() { return false; },
        shutdown: function() {},
        saveTextToFile: function(file, contents, cb) { if (cb) { cb(); } },
        readTextFromFile: function(file, cb) { if (cb) { cb(''); } },
        isCloudEnabledForUser: function() { return false; },
        isCloudEnabled: function() { return false; },
        enableCloud: function() {},
        getCloudQuota: function(cb) { if (cb) { cb(0, 0); } },
        getSteamId: function() { return 0; },
        activateAchievement: function(name, cb) { if (cb) { cb(); } },
        clearAchievement: function(name, cb) { if (cb) { cb(); } },
        getAchievement: function(name, cb) { if (cb) { cb(false); } },
        getAchievementNames: function() { return []; },
        getNumberOfAchievements: function() { return 0; },
        getCurrentGameLanguage: function() { return 'en'; },
        getNumberOfPlayers: function(cb) { if (cb) { cb(1); } },
        activateGameOverlay: function() {},
        isGameOverlayEnabled: function() { return false; },
        activateGameOverlayToWebPage: function() {},
        getGamepadConnected: function() { return false; },
        fileExists: function() { return false; },
        deleteFile: function() {}
    };

    //-------------------------------------------------------------------------
    // localStorage-backed virtual file store
    //-------------------------------------------------------------------------
    function lsKey(p) { return LS_PREFIX + p; }

    function virtualFileKey(abs) {
        // returns the storage key when a FILE exists at abs (either store)
        var key = lsKey(abs);
        if (localStorage.getItem(key) !== null) { return key; }
        if (Object.prototype.hasOwnProperty.call(memFiles, key)) { return key; }
        return null;
    }

    function virtualChildExists(abs) {
        // returns true when any file exists below abs/ (directory check)
        var prefix = abs.replace(/\/+$/, '') + '/';
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k && k.indexOf(LS_PREFIX) === 0 && k.slice(LS_PREFIX.length).indexOf(prefix) === 0) {
                return true;
            }
        }
        for (var m in memFiles) {
            if (Object.prototype.hasOwnProperty.call(memFiles, m) &&
                m.indexOf(LS_PREFIX) === 0 && m.slice(LS_PREFIX.length).indexOf(prefix) === 0) {
                return true;
            }
        }
        return false;
    }

    function virtualExists(abs) {
        if (virtualFileKey(abs)) { return true; }
        return virtualChildExists(abs);
    }

    function virtualStat(abs) {
        var fkey = virtualFileKey(abs);
        var isDir = !fkey && virtualChildExists(abs);
        if (!fkey && !isDir) { return null; }
        var size = 4096;
        if (fkey) {
            var lsV = localStorage.getItem(fkey);
            size = (lsV !== null) ? String(lsV).length : memFiles[fkey].length;
        }
        return {
            size: size,
            isFile: function() { return !!fkey; },
            isDirectory: function() { return !fkey; },
            isBlockDevice: function() { return false; },
            isCharacterDevice: function() { return false; },
            isSymbolicLink: function() { return false; },
            isFIFO: function() { return false; },
            isSocket: function() { return false; }
        };
    }

    function makeErr(code, msg) {
        var e = new Error(msg);
        e.code = code;
        return e;
    }

    function notFoundErr(p) {
        return makeErr('ENOENT', "ENOENT: no such file or directory, scandir '" + p + "'");
    }

    //-------------------------------------------------------------------------
    // fs shim
    //-------------------------------------------------------------------------
    function httpGetSync(url) {
        var xhr = new XMLHttpRequest();
        try {
            xhr.open('GET', url, false);
            xhr.send();
        } catch (e) {
            return null;
        }
        if (xhr.status === 200 || (xhr.status === 0 && xhr.responseText !== '')) { return xhr; }
        return null;
    }

    function manifestChildren(absUrl) {
        var origin = originOf(absUrl);
        var rest = decodeURIPath(normalizeRest(absUrl.slice(origin.length)));
        var basePath = basePathOf(BASE_URL);
        var base = basePath.toLowerCase();
        var k = rest.toLowerCase();
        if (base !== '/' && k.indexOf(base) === 0) { rest = rest.slice(basePath.length); }
        var prefix = rest.replace(/^\/+/, '').replace(/\/+$/, '');
        prefix = prefix === '' ? '' : prefix + '/';
        prefix = prefix.toLowerCase(); // MANIFEST keys are all lowercase
        var children = {};
        var found = false;
        for (var mk in MANIFEST) {
            if (!Object.prototype.hasOwnProperty.call(MANIFEST, mk)) { continue; }
            if (prefix === '' || mk.indexOf(prefix) === 0) {
                found = true;
                var rem = mk.slice(prefix.length);
                var seg = rem.split('/')[0];
                if (!seg) { continue; }
                var actualRem = MANIFEST[mk].slice(prefix.length);
                children[actualRem.split('/')[0]] = true;
            }
        }
        return found ? Object.keys(children) : null;
    }

    var B64_PREFIX = 'b64:';
    var fdBuffers = {};
    // Per-file cap (in chars) of the value known to fit in localStorage. The log file
    // can grow far beyond localStorage's ~5MB quota; persistFdBuffers bounds what we
    // write and NEVER throws, so a huge log can't crash the loader mid-boot.
    var fdPersistCap = {};
    var FD_PERSIST_DEFAULT = 3000000;
    function persistFdBuffers(abs, key) {
        var buf = fdBuffers[abs];
        if (buf === undefined) { return; }
        // ceiling = largest tail we believe fits the localStorage quota (adaptive).
        var ceiling = (fdPersistCap[abs] !== undefined) ? fdPersistCap[abs] : FD_PERSIST_DEFAULT;
        if (ceiling <= 0) { return; } // known un-persistable; keep in memory only
        var cap = Math.min(ceiling, buf.length);
        for (;;) {
            var attempt = buf.slice(buf.length - cap);
            try {
                localStorage.setItem(key, attempt);
                return; // fits; ceiling unchanged (it tracks quota, not buffer size)
            } catch (e) {
                if (cap <= 512) {
                    // Quota exhausted even for a tiny tail - drop persistence rather than
                    // throw. The full file stays available in memory (fdBuffers).
                    fdPersistCap[abs] = 0;
                    try { localStorage.removeItem(key); } catch (e2) {}
                    return;
                }
                cap = (cap / 2) | 0;
                fdPersistCap[abs] = cap; // remember a size more likely to fit
            }
        }
    }

    function encodeForStorage(data) {
        if (data instanceof WebBuffer) { return B64_PREFIX + b64Encode(data._u8); }
        if (data instanceof Uint8Array) { return B64_PREFIX + b64Encode(data); }
        if (ArrayBuffer.isView(data)) { return B64_PREFIX + b64Encode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); }
        if (data instanceof ArrayBuffer) { return B64_PREFIX + b64Encode(new Uint8Array(data)); }
        return String(data);
    }
    function decodeFromStorage(v) {
        if (v.indexOf(B64_PREFIX) === 0) { return new WebBuffer(b64Decode(v.slice(B64_PREFIX.length))); }
        return new WebBuffer(v);
    }

    function httpGetBytesSync(url) {
        var xhr = new XMLHttpRequest();
        try {
            xhr.open('GET', url, false);
        } catch (e) { return null; }
        // Sync XHR made from a document CANNOT use responseType='arraybuffer'
        // (browsers throw: "The response type cannot be changed for synchronous
        // requests"). Without intervention the browser decodes the body as UTF-8
        // via responseText, which corrupts binary files (e.g. an invalid PNG
        // header byte \x89 becomes U+FFFD). The x-user-defined charset makes each
        // responseText char map 1:1 to a raw byte, recovered via charCodeAt.
        try { xhr.overrideMimeType('text/plain; charset=x-user-defined'); } catch (e) { /* ignore */ }
        try {
            xhr.responseType = 'arraybuffer';
        } catch (e) { /* sync XHR rejects responseType; x-user-defined fallback handles it */ }
        try {
            xhr.send();
        } catch (e) { return null; }
        if (xhr.status !== 200 && xhr.status !== 0) { return null; }
        if (xhr.response instanceof ArrayBuffer) {
            return new Uint8Array(xhr.response);
        }
        var text = '';
        try { text = xhr.responseText; } catch (e) { return null; }
        // Recover raw bytes: with x-user-defined each char code is the byte value
        // (high bytes may arrive as U+00XX); & 0xFF normalizes them.
        var out = new Uint8Array(text.length);
        for (var i = 0; i < text.length; i++) {
            out[i] = text.charCodeAt(i) & 0xFF;
        }
        return out;
    }

    //-------------------------------------------------------------------------
    // IndexedDB spill layer for uploaded mods.
    // localStorage (~5MB, shared with saves) can't hold big mods, so uploads
    // live in IndexedDB instead. Every file is cached raw in `memFiles` so the
    // synchronous fs APIs keep working: hydration loads the whole store into
    // memory at startup and `window.__webFsHydration` resolves when done.
    // All async fs calls (and the OneLoader mod scan) await it first, so no
    // code ever observes a half-loaded mod store. Keys are the same
    // "omori_web_fs:<abs>" strings localStorage uses; when a key exists in
    // both stores, localStorage (legacy layer) wins on reads.
    //-------------------------------------------------------------------------
    var IDB_DB_NAME = 'omori_web_mods';
    var IDB_STORE = 'files';
    var MODS_LS_PREFIX = LS_PREFIX + normalizeAny(BASE_URL + 'mods') + '/';
    var memFiles = {}; // lsKey -> Uint8Array (raw bytes, no b64 wrapper)
    var hydrationDone = false;
    var idbOpenPromise = null;

    function idbOpen() {
        if (idbOpenPromise) { return idbOpenPromise; }
        idbOpenPromise = new Promise(function(resolve, reject) {
            if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available')); return; }
            var req = indexedDB.open(IDB_DB_NAME, 1);
            req.onupgradeneeded = function() {
                var db = req.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) { db.createObjectStore(IDB_STORE); }
            };
            req.onsuccess = function() { resolve(req.result); };
            req.onerror = function() { reject(req.error || new Error('IndexedDB open failed')); };
            req.onblocked = function() { reject(new Error('IndexedDB open blocked')); };
        });
        return idbOpenPromise;
    }

    function idbLoadAll() {
        return idbOpen().then(function(db) {
            return new Promise(function(resolve, reject) {
                var out = {};
                var tx = db.transaction(IDB_STORE, 'readonly');
                var range = IDBKeyRange.bound(MODS_LS_PREFIX, MODS_LS_PREFIX + '\uffff');
                var req = tx.objectStore(IDB_STORE).openCursor(range);
                req.onsuccess = function() {
                    var cur = req.result;
                    if (cur) { out[cur.key] = cur.value; cur.continue(); }
                };
                req.onerror = function() { reject(req.error); };
                tx.oncomplete = function() { resolve(out); };
                tx.onerror = function() { reject(tx.error); };
                tx.onabort = function() { reject(tx.error); };
            });
        });
    }

    function idbBatch(mode, action) {
        // action(store) runs inside one transaction; transaction completion
        // (atomic) resolves the promise.
        return idbOpen().then(function(db) {
            return new Promise(function(resolve, reject) {
                var tx = db.transaction(IDB_STORE, mode);
                try { action(tx.objectStore(IDB_STORE)); } catch (e) { reject(e); return; }
                tx.oncomplete = function() { resolve(true); };
                tx.onerror = function() { reject(tx.error || new Error('IndexedDB transaction failed')); };
                tx.onabort = function() { reject(tx.error || new Error('IndexedDB transaction aborted')); };
            });
        });
    }

    var hydrationPromise = idbLoadAll().then(function(loaded) {
        for (var k in loaded) {
            if (!Object.prototype.hasOwnProperty.call(loaded, k)) { continue; }
            var v = loaded[k];
            memFiles[k] = (v instanceof Uint8Array) ? v : new Uint8Array(v);
        }
        hydrationDone = true;
        return true;
    }, function(e) {
        hydrationDone = true; // never wedge the boot; installs will report the failure
        try { if (window._logLine) { window._logLine('web_compat: mod store hydration failed: ' + e); } } catch (e2) {}
        return false;
    });
    window.__webFsHydration = hydrationPromise;

    function afterHydration(fn) {
        if (hydrationDone) { fn(); return; }
        hydrationPromise.then(fn, fn);
    }

    window.__webFsSpill = {
        memFiles: memFiles,          // live map: lsKey -> Uint8Array
        isHydrated: function() { return hydrationDone; },
        ready: function() { return hydrationPromise; },
        put: function(key, u8) { memFiles[key] = u8; },
        persist: function(pairs) {
            return idbBatch('readwrite', function(store) {
                for (var i = 0; i < pairs.length; i++) { store.put(pairs[i].u8, pairs[i].key); }
            });
        },
        removePrefix: function(prefix) {
            return idbOpen().then(function(db) {
                return new Promise(function(resolve, reject) {
                    var keys = [];
                    var tx = db.transaction(IDB_STORE, 'readwrite');
                    var range = IDBKeyRange.bound(prefix, prefix + '\uffff');
                    var store = tx.objectStore(IDB_STORE);
                    var req = store.openCursor(range);
                    req.onsuccess = function() {
                        var cur = req.result;
                        if (cur) { keys.push(cur.key); cur.continue(); }
                    };
                    req.onerror = function() { reject(req.error); };
                    tx.oncomplete = function() {
                        if (keys.length === 0) { resolve(0); return; }
                        idbBatch('readwrite', function(s2) {
                            for (var j = 0; j < keys.length; j++) { s2.delete(keys[j]); }
                        }).then(function() { resolve(keys.length); }, reject);
                    };
                    tx.onerror = function() { reject(tx.error); };
                    tx.onabort = function() { reject(tx.error); };
                });
            });
        }
    };

    var fsShim = {
        readFileSync: function(p, options) {
            var rp = resolveDiskPath(p);
            if (rp) { p = rp; }
            var abs = toAbs(p);
            var enc = (typeof options === 'string') ? options : (options && options.encoding) || null;
            var key = lsKey(abs);
            // Prefer the live in-memory buffer (complete, un-truncated) over the bounded
            // localStorage copy - this is what keeps the full latest.log readable even if
            // only a tail was persisted due to the localStorage quota.
            if (Object.prototype.hasOwnProperty.call(fdBuffers, abs)) {
                var fb = fdBuffers[abs];
                return enc ? fb : new WebBuffer(fb);
            }
            var v = localStorage.getItem(key);
            if (v === null && Object.prototype.hasOwnProperty.call(memFiles, key)) {
                var mbuf = new WebBuffer(memFiles[key]);
                return enc ? mbuf.toString(enc === 'utf8' || enc === 'utf-8' ? 'utf8' : enc) : mbuf;
            }
            if (v !== null) {
                var buf = decodeFromStorage(v);
                return enc ? buf.toString(enc === 'utf8' || enc === 'utf-8' ? 'utf8' : enc) : buf;
            }
            if (!isUrl(abs)) { throw notFoundErr(p); }
            if (enc) {
                var xhr = httpGetSync(canonicalUrl(abs));
                if (!xhr) { throw notFoundErr(p); }
                return xhr.responseText;
            }
            var bytes = httpGetBytesSync(canonicalUrl(abs));
            if (!bytes) { throw notFoundErr(p); }
            return new WebBuffer(bytes);
        },

        readFile: function(p, options, callback) {
            if (typeof options === 'function') { callback = options; options = null; }
            var enc = (typeof options === 'string') ? options : (options && options.encoding) || null;
            var rp = resolveDiskPath(p);
            if (rp) { p = rp; }
            afterHydration(function() {
            setTimeout(function() {
                var abs = toAbs(p);
                try {
                    var v = localStorage.getItem(lsKey(abs));
                    if (v === null && Object.prototype.hasOwnProperty.call(memFiles, lsKey(abs))) {
                        var mbuf = new WebBuffer(memFiles[lsKey(abs)]);
                        callback(null, enc ? mbuf.toString(enc === 'utf8' || enc === 'utf-8' ? 'utf8' : enc) : mbuf);
                        return;
                    }
                    if (v !== null) {
                        var buf = decodeFromStorage(v);
                        callback(null, enc ? buf.toString(enc === 'utf8' || enc === 'utf-8' ? 'utf8' : enc) : buf);
                        return;
                    }
                    if (!isUrl(abs)) { callback(notFoundErr(p), null); return; }
                    var url = canonicalUrl(abs);
                    var xhr = new XMLHttpRequest();
                    xhr.open('GET', url, true);
                    if (!enc) {
                        try { xhr.responseType = 'arraybuffer'; } catch (e) {}
                    }
                    xhr.onload = function() {
                        if (xhr.status === 200 || (xhr.status === 0 && xhr.responseText !== '')) {
                            if (!enc && xhr.response instanceof ArrayBuffer) {
                                callback(null, new WebBuffer(new Uint8Array(xhr.response)));
                            } else {
                                callback(null, xhr.responseText);
                            }
                        } else {
                            callback(notFoundErr(p), null);
                        }
                    };
                    xhr.onerror = function() { callback(makeErr('ENETWORK', 'Network error reading ' + p), null); };
                    xhr.send();
                } catch (e) {
                    callback(e, null);
                }
            }, 0);
            });
        },

        writeFileSync: function(p, data) {
            localStorage.setItem(lsKey(toAbs(p)), encodeForStorage(data));
        },

        writeFile: function(p, data, callback) {
            setTimeout(function() {
                try {
                    localStorage.setItem(lsKey(toAbs(p)), encodeForStorage(data));
                    if (callback) { callback(null); }
                } catch (e) {
                    if (callback) { callback(e); }
                }
            }, 0);
        },

        appendFileSync: function(p, data) {
            var abs = toAbs(p);
            var key = lsKey(abs);
            var prev = localStorage.getItem(key);
            if (prev === null) { localStorage.setItem(key, encodeForStorage(data)); return; }
            var prevBytes = decodeFromStorage(prev)._u8;
            var addBytes = (data instanceof WebBuffer) ? data._u8 : utf8Encode(typeof data === 'string' ? data : String(data));
            var merged = new Uint8Array(prevBytes.length + addBytes.length);
            merged.set(prevBytes);
            merged.set(addBytes, prevBytes.length);
            localStorage.setItem(key, B64_PREFIX + b64Encode(merged));
        },

        openSync: function(p, flags) {
            var abs = toAbs(p);
            if (flags && String(flags).indexOf('w') !== -1) {
                localStorage.removeItem(lsKey(abs));
                delete fdBuffers[abs];
            }
            return { __web_fd_path: abs };
        },
        writeSync: function(fd, data) {
            var abs = (fd && fd.__web_fd_path) ? fd.__web_fd_path : toAbs(fd);
            var key = lsKey(abs);
            var text = (typeof data === 'string') ? data
                : (data instanceof WebBuffer ? utf8Decode(data._u8) : String(data));
            fdBuffers[abs] = (fdBuffers[abs] !== undefined ? fdBuffers[abs] : (localStorage.getItem(key) || '')) + text;
            fd.__web_count = (fd.__web_count || 0) + 1;
            if (fd.__web_count % 25 === 0) {
                persistFdBuffers(abs, key); // bounded + never throws (quota-safe)
            }
            return text.length;
        },
        closeSync: function(fd) {
            if (fd && fd.__web_fd_path && fdBuffers[fd.__web_fd_path] !== undefined) {
                // Persist a bounded copy, but KEEP the full buffer in memory so
                // readFileSync can still return the complete file (e.g. latest.log).
                persistFdBuffers(fd.__web_fd_path, lsKey(fd.__web_fd_path));
            }
            return 0;
        },

        readdirSync: function(p) {
            var abs = toAbs(p);
            var names = {};
            var prefix = abs.replace(/\/+$/, '') + '/';
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (!k || k.indexOf(LS_PREFIX) !== 0) { continue; }
                var rest = k.slice(LS_PREFIX.length);
                if (rest.indexOf(prefix) === 0) {
                    var seg = rest.slice(prefix.length).split('/')[0];
                    if (seg) { names[seg] = true; }
                }
            }
            for (var mi in memFiles) {
                if (!Object.prototype.hasOwnProperty.call(memFiles, mi)) { continue; }
                if (mi.indexOf(LS_PREFIX) !== 0) { continue; }
                var mrest = mi.slice(LS_PREFIX.length);
                if (mrest.indexOf(prefix) === 0) {
                    var mseg = mrest.slice(prefix.length).split('/')[0];
                    if (mseg) { names[mseg] = true; }
                }
            }
            if (!isUrl(abs)) { return Object.keys(names); }
            var children = manifestChildren(canonicalUrl(abs));
            if (children) {
                for (var j = 0; j < children.length; j++) { names[children[j]] = true; }
            } else if (Object.keys(names).length === 0) {
                throw notFoundErr(p);
            }
            return Object.keys(names);
        },

        statSync: function(p) {
            var abs = toAbs(p);
            var st = virtualStat(abs);
            if (st) { return st; }
            if (!isUrl(abs)) { throw notFoundErr(p); }
            var url = canonicalUrl(abs);
            if (resolveAsset(url)) {
                return {
                    size: 0,
                    isFile: function() { return true; },
                    isDirectory: function() { return false; },
                    isBlockDevice: function() { return false; },
                    isCharacterDevice: function() { return false; },
                    isSymbolicLink: function() { return false; },
                    isFIFO: function() { return false; },
                    isSocket: function() { return false; }
                };
            }
            var children = manifestChildren(url);
            if (children) {
                return {
                    size: 4096,
                    isFile: function() { return false; },
                    isDirectory: function() { return true; },
                    isBlockDevice: function() { return false; },
                    isCharacterDevice: function() { return false; },
                    isSymbolicLink: function() { return false; },
                    isFIFO: function() { return false; },
                    isSocket: function() { return false; }
                };
            }
            throw notFoundErr(p);
        },

        existsSync: function(p) {
            try {
                fsShim.statSync(p);
                return true;
            } catch (e) {
                return false;
            }
        },

        mkdirSync: function() { return true; },

        unlinkSync: function(p) {
            var k = lsKey(toAbs(p));
            localStorage.removeItem(k);
            delete memFiles[k];
        },

        unlink: function(p, callback) {
            afterHydration(function() {
                setTimeout(function() {
                    var k = lsKey(toAbs(p));
                    localStorage.removeItem(k);
                    delete memFiles[k];
                    if (callback) { callback(null); }
                }, 0);
            });
        },

        stat: function(p, callback) {
            afterHydration(function() {
                setTimeout(function() {
                    try {
                        callback(null, fsShim.statSync(p));
                    } catch (e) {
                        callback(e, null);
                    }
                }, 0);
            });
        },

        readdir: function(p, callback) {
            afterHydration(function() {
                setTimeout(function() {
                    try {
                        callback(null, fsShim.readdirSync(p));
                    } catch (e) {
                        callback(e, null);
                    }
                }, 0);
            });
        },

        lstatSync: function(p) { return fsShim.statSync(p); },
        realpathSync: function(p) { return toAbs(p); },
        readlinkSync: function() { throw makeErr('EINVAL', 'EINVAL: invalid argument'); },
        rmdirSync: function() { return true; },
        rmSync: function() { return true; },
        renameSync: function() {},
        copyFileSync: function() {},
        createWriteStream: function() { return { write: function() {}, end: function() {}, on: function() {} }; },
        createReadStream: function() { return { on: function() {}, pipe: function() {} }; },
        promises: {}
    };

    //-------------------------------------------------------------------------
    // Mini CommonJS loader (used for js-yaml)
    //-------------------------------------------------------------------------
    var cjsCache = {};

    function cjsLoad(url) {
        url = canonicalUrl(url);
        if (Object.prototype.hasOwnProperty.call(cjsCache, url)) {
            return cjsCache[url].exports;
        }
        var code = null;
        var cached = localStorage.getItem(lsKey(url));
        if (cached !== null) {
            code = cached;
        } else {
            var xhr = httpGetSync(url);
            if (!xhr) { throw new Error('Cannot load module: ' + url); }
            code = xhr.responseText;
        }
        var module = { exports: {} };
        cjsCache[url] = module;
        var dir = pathDirname(url);

        function localRequire(req) {
            if (req.charAt(0) === '.' || req.charAt(0) === '/') {
                var target;
                if (req.charAt(0) === '/') {
                    target = originOf(url) + req;
                } else {
                    target = dir + '/' + req;
                }
                target = normalizeAny(target);
                var candidates = [];
                if (/\.(js|json)$/.test(target)) { candidates.push(target); }
                candidates.push(target + '.js');
                candidates.push(target + '.json');
                candidates.push(target + '/index.js');
                for (var i = 0; i < candidates.length; i++) {
                    var c = candidates[i];
                    var resolved = resolveAsset(c);
                    if (resolved || httpGetSync(c)) {
                        return cjsLoad(resolved || c);
                    }
                }
                throw new Error('Cannot find module \'' + req + '\' from ' + url);
            }
            // Node built-ins used (optionally) by js-yaml; stubbed out.
            if (req === 'buffer') { return { Buffer: WebBuffer }; }
            return {};
        }

        var wrapper;
        try {
            wrapper = new Function('module', 'exports', 'require', '__filename', '__dirname', code + '\n//# sourceURL=' + url);
        } catch (e) {
            throw new Error('Error evaluating ' + url + ': ' + e.message);
        }
        wrapper(module, module.exports, localRequire, url, pathDirname(url));
        return module.exports;
    }

    //-------------------------------------------------------------------------
    // global require
    //-------------------------------------------------------------------------
    window.require = function(name) {
        switch (name) {
            case 'path': return pathShim;
            case 'fs': return fsShim;
            case 'os': return osShim;
            case 'crypto': return cryptoShim;
            case 'child_process': return { exec: function() {}, execSync: function() { return ''; }, spawn: function() { return { on: function() {} }; } };
            case 'nw.gui': return nwGuiShim;
            case 'pixi.js': return window.PIXI || {};
            case 'electron': return { shell: nwGuiShim.Shell };
            case 'util': return utilShim;
            case 'zlib': return zlibShim;
            case 'events': return eventsShim;
            case 'stream': return streamShim;
            case 'buffer': return { Buffer: WebBuffer };
        }
        if (/greenworks$/.test(name)) { return greenworksStub; }
        if (/node_stream_zip\.js$/.test(name)) { return StreamZipStub; }
        if (/js-yaml-master/.test(name)) {
            return cjsLoad(BASE_URL + 'js/libs/js-yaml-master/index.js');
        }
        if (name.charAt(0) === '.') {
            var target = BASE_URL + name.replace(/^\.\//, '');
            // Node probes candidates for extension-less requires
            // (e.g. require('./js/libs/js-yaml-master') -> .../index.js)
            var candidates = [target];
            if (!/\.(js|json|node)$/.test(target)) {
                candidates.push(target + '.js', target + '.json', target + '/index.js');
            }
            var lastErr = null;
            for (var ci = 0; ci < candidates.length; ci++) {
                try { return cjsLoad(candidates[ci]); } catch (e) { lastErr = e; }
            }
            throw lastErr || new Error('[require] Cannot load module: ' + name);
        }
        return {};
    };

    //-------------------------------------------------------------------------
    // Case-correct all asset requests (XHR, fetch, media elements)
    // and serve OneLoader overlay files (mod files that replace disk files)
    //-------------------------------------------------------------------------
    function overlayHit(p) {
        try {
            if (!window.$modLoader || !$modLoader.overlayFS) { return null; }
            if (typeof window._read_file_Sync !== 'function') { return null; }
            var abs = toAbs(p);
            if (!isUrl(abs)) { return null; }
            var rest = abs.slice(originOf(abs).length);
            var basePath = basePathOf(BASE_URL);
            var base = basePath.toLowerCase();
            if (base !== '/' && rest.toLowerCase().indexOf(base) === 0) { rest = rest.slice(basePath.length); }
            var rel = decodeURIPath(normalizeRest(rest)).replace(/^\/+/, '').toLowerCase();
            if (!rel) { return null; }
            var parts = rel.split('/').filter(Boolean);
            var fileName = parts.pop();
            var current = $modLoader.overlayFS;
            for (var i = 0; i < parts.length; i++) {
                if (current[parts[i]] && current[parts[i]].children) {
                    current = current[parts[i]].children;
                } else {
                    return null;
                }
            }
            var entry = current[fileName];
            if (!entry || entry.type === 'dir') {
                try { entry = current[decodeURIComponent(fileName)]; } catch (e) {}
                if (!entry || entry.type === 'dir') { return null; }
            }
            var data = window._read_file_Sync(entry.dataSource);
            if (data == null) { return null; }
            if (data instanceof WebBuffer) { return data; }
            if (data instanceof Uint8Array) { return new WebBuffer(data); }
            return new WebBuffer(data);
        } catch (e) {
            return null;
        }
    }

    function overlayBlobUrl(p) {
        var data = overlayHit(p);
        if (!data) { return null; }
        var mime = 'application/octet-stream';
        if (/\.png$/i.test(p)) { mime = 'image/png'; }
        else if (/\.jpg$|\.jpeg$/i.test(p)) { mime = 'image/jpeg'; }
        else if (/\.gif$/i.test(p)) { mime = 'image/gif'; }
        else if (/\.ogg$/i.test(p)) { mime = 'audio/ogg'; }
        else if (/\.m4a$/i.test(p)) { mime = 'audio/mp4'; }
        else if (/\.webm$/i.test(p)) { mime = 'video/webm'; }
        else if (/\.webp$/i.test(p)) { mime = 'image/webp'; }
        else if (/\.json$/i.test(p)) { mime = 'application/json'; }
        return URL.createObjectURL(new Blob([data._u8], { type: mime }));
    }

    var origXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, async) {
        this.__webAbs = null;
        this.__webAsync = async !== false;
        if (typeof url === 'string') {
            try {
                var abs = toAbs(url);
                this.__webAbs = abs;
                arguments[1] = canonicalUrl(abs);
            } catch (e) { /* keep original */ }
        }
        return origXhrOpen.apply(this, arguments);
    };

    var origXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function() {
        if (this.__webAbs && this.__webAsync) {
            var data = overlayHit(this.__webAbs);
            if (data) {
                var self = this;
                setTimeout(function() {
                    var text = utf8Decode(data._u8);
                    var rt = '';
                    try { rt = self.responseType; } catch (e) {}
                    Object.defineProperty(self, 'responseText', { configurable: true, get: function() { return text; } });
                    Object.defineProperty(self, 'response', { configurable: true, get: function() {
                        if (rt === 'arraybuffer') { return data._u8.slice().buffer; }
                        return text;
                    } });
                    Object.defineProperty(self, 'status', { configurable: true, get: function() { return 200; } });
                    Object.defineProperty(self, 'statusText', { configurable: true, get: function() { return 'OK'; } });
                    Object.defineProperty(self, 'readyState', { configurable: true, get: function() { return 4; } });
                    if (self.onreadystatechange) { self.onreadystatechange(); }
                    if (self.onload) { self.onload(); }
                }, 0);
                return;
            }
        }
        return origXhrSend.apply(this, arguments);
    };

    if (window.fetch) {
        var origFetch = window.fetch;
        window.fetch = function(input, init) {
            if (typeof input === 'string') {
                try { input = canonicalUrl(input); } catch (e) { /* keep original */ }
            }
            return origFetch.call(this, input, init);
        };
    }

    function patchSrcProperty(proto) {
        if (!proto) { return; }
        var desc = Object.getOwnPropertyDescriptor(proto, 'src');
        if (!desc || !desc.set || !desc.get) { return; }
        Object.defineProperty(proto, 'src', {
            configurable: true,
            enumerable: desc.enumerable,
            get: function() { return desc.get.call(this); },
            set: function(value) {
                if (typeof value === 'string') {
                    try {
                        var blobUrl = overlayBlobUrl(value);
                        if (blobUrl) {
                            value = blobUrl;
                            return desc.set.call(this, value);
                        }
                        value = canonicalUrl(value);
                    } catch (e) { /* keep original */ }
                }
                return desc.set.call(this, value);
            }
        });
    }

    patchSrcProperty(window.HTMLImageElement && window.HTMLImageElement.prototype);
    patchSrcProperty(window.HTMLVideoElement && window.HTMLVideoElement.prototype);
    patchSrcProperty(window.HTMLAudioElement && window.HTMLAudioElement.prototype);
    patchSrcProperty(window.HTMLSourceElement && window.HTMLSourceElement.prototype);

    // PluginManager.loadScript: serve mod plugins from the overlay (blob URL)
    // and force in-order execution (script-inserted scripts default to
    // load-completion order in Chromium; async=false joins the ordered list).
    var pluginPoll = setInterval(function() {
        if (window.PluginManager && PluginManager.loadScript && !PluginManager.__webOverlayPatched) {
            PluginManager.loadScript = function(name) {
                var data = overlayHit('js/plugins/' + name);
                var s = document.createElement('script');
                s.type = 'text/javascript';
                if (data) {
                    s.src = URL.createObjectURL(new Blob([utf8Decode(data._u8)], { type: 'application/javascript' }));
                } else {
                    s.src = canonicalUrl(toAbs('js/plugins/' + name));
                }
                s.async = false;
                s._url = 'js/plugins/' + name;
                document.body.appendChild(s);
            };
            PluginManager.__webOverlayPatched = true;
            clearInterval(pluginPoll);
        }
    }, 20);

    // Guard CanvasRenderingContext2D.drawImage against broken/unfinished images.
    // A broken HTMLImageElement (e.g. a mod-provided loading image that 404'd)
    // makes canvas.drawImage throw InvalidStateError. Under GTP_OmoriFixes that
    // throw escapes SceneManager.update (renderScene is outside its try/catch)
    // and reaches PIXI's Ticker, which only re-requests the next animation frame
    // AFTER update() returns -- so the throw permanently freezes the game. Skipping
    // the draw of an unloadable image is strictly better than crashing, and is a
    // general fix that protects EVERY mod from any broken-image render crash.
    if (window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype.drawImage) {
        var __origDrawImage = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function(img) {
            if (img && (img.tagName === 'IMG' || (window.HTMLImageElement && img instanceof HTMLImageElement))) {
                if (!img.complete || img.naturalWidth === 0) { return; }
            }
            return __origDrawImage.apply(this, arguments);
        };
    }

    // Non-blocking toast notifications for the modloader. Replaces native
    // alert() calls that would otherwise freeze boot mid-load. Shows a small
    // auto-dismissing banner in a corner and always mirrors to console + log.
    window.__modloaderNotify = function(msg, kind) {
        try { console.warn('[modloader] ' + msg); } catch (e) {}
        try { if (window._logLine) { window._logLine('| [NOTIFY] ' + msg); } } catch (e) {}
        try {
            if (!document.body) { return; }
            var host = document.getElementById('__modloader_toasts');
            if (!host) {
                host = document.createElement('div');
                host.id = '__modloader_toasts';
                host.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99999;max-width:420px;display:flex;flex-direction:column;gap:6px;pointer-events:none;font-family:sans-serif;';
                document.body.appendChild(host);
            }
            var el = document.createElement('div');
            el.style.cssText = 'pointer-events:auto;background:rgba(20,20,25,0.92);color:#fff;border:1px solid ' +
                (kind === 'error' ? '#c0392b' : kind === 'warn' ? '#e67e22' : '#3498db') +
                ';border-radius:6px;padding:10px 14px;font-size:13px;line-height:1.4;box-shadow:0 2px 10px rgba(0,0,0,0.5);word-break:break-word;';
            var close = document.createElement('div');
            close.textContent = '\\u00d7';
            close.style.cssText = 'float:right;margin-left:10px;cursor:pointer;font-weight:bold;opacity:0.7;';
            close.onclick = function() { if (el.parentNode) { el.parentNode.removeChild(el); } };
            el.appendChild(close);
            var txt = document.createElement('div');
            txt.textContent = msg;
            el.appendChild(txt);
            host.appendChild(el);
            // errors stay until dismissed; others auto-dismiss after 9s
            if (kind !== 'error') {
                setTimeout(function() { if (el.parentNode) { el.parentNode.removeChild(el); } }, 9000);
            }
        } catch (e) {}
    };

    // Make the PIXI game loop resilient to render/update exceptions.
    // PIXI re-requests the next animation frame only AFTER update() returns
    // (see Ticker._tick), so an uncaught throw from a listener (e.g. a broken
    // image drawn in Graphics._paintUpperCanvas during renderScene) permanently
    // freezes the game on that frame. Swallow + log the error so the ticker
    // survives. This is a general fix that protects EVERY mod from any render
    // crash freezing the whole game.
    var tickerPoll = setInterval(function() {
        var proto = window.PIXI && window.PIXI.Ticker && window.PIXI.Ticker.prototype;
        if (proto && proto.update && !proto.__webResilientUpdate) {
            var origUpdate = proto.update;
            var lastLogged = 0;
            proto.update = function(currentTime) {
                window.__webTick = (window.__webTick | 0) + 1;
                try {
                    return origUpdate.call(this, currentTime);
                } catch (e) {
                    var now = Date.now();
                    if (now - lastLogged > 1000) {
                        lastLogged = now;
                        console.error('[web] game-loop exception (recovered):', e);
                        try { if (window._logLine) { window._logLine('[RECOVERED] game loop error: ' + ((e && e.message) || e)); } } catch (e2) {}
                    }
                }
            };
            proto.__webResilientUpdate = true;
            clearInterval(tickerPoll);
        }
    }, 20);
})();
