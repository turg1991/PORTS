// include: shell.js
// include: minimum_runtime_check.js
// end include: minimum_runtime_check.js
// The Module object: Our interface to the outside world. We import
// and export values on it. There are various ways Module can be used:
// 1. Not defined. We create it here
// 2. A function parameter, function(moduleArg) => Promise<Module>
// 3. pre-run appended it, var Module = {}; ..generated code..
// 4. External script tag defines var Module.
// We need to check if Module already exists (e.g. case 3 above).
// Substitution will be replaced with actual code on later stage of the build,
// this way Closure Compiler will not mangle it (e.g. case 4. above).
// Note that if you want to run closure, and also to use Module
// after the generated code, you will need to define   var Module = {};
// before the code. Then that object will be used in the code, and you
// can continue to use Module afterwards as well.
var Module = typeof Module !== "undefined" ? Module : {};

// Determine the runtime environment we are in. You can customize this by
// setting the ENVIRONMENT setting at compile time (see settings.js).
// Attempt to auto-detect the environment
var ENVIRONMENT_IS_WEB = !!globalThis.window;

var ENVIRONMENT_IS_WORKER = !!globalThis.WorkerGlobalScope;

// N.b. Electron.js environment is simultaneously a NODE-environment, but
// also a web environment.
var ENVIRONMENT_IS_NODE = globalThis.process?.versions?.node && globalThis.process?.type != "renderer";

var ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;

// Three configurations we can be running in:
// 1) We could be the application main() thread running in the main JS UI thread. (ENVIRONMENT_IS_WORKER == false and ENVIRONMENT_IS_PTHREAD == false)
// 2) We could be the application main() running directly in a worker. (ENVIRONMENT_IS_WORKER == true, ENVIRONMENT_IS_PTHREAD == false)
// 3) We could be an application pthread running in a worker. (ENVIRONMENT_IS_WORKER == true and ENVIRONMENT_IS_PTHREAD == true)
// The way we signal to a worker that it is hosting a pthread is to construct
// it with a specific name.
var ENVIRONMENT_IS_PTHREAD = ENVIRONMENT_IS_WORKER && globalThis.name == "em-pthread";

if (ENVIRONMENT_IS_NODE) {
  var worker_threads = require("node:worker_threads");
  globalThis.Worker = worker_threads.Worker;
  ENVIRONMENT_IS_WORKER = !worker_threads.isMainThread;
  // Under node we set `workerData` to `em-pthread` to signal that the worker
  // is hosting a pthread.
  ENVIRONMENT_IS_PTHREAD = ENVIRONMENT_IS_WORKER && worker_threads.workerData == "em-pthread";
}

// --pre-jses are emitted after the Module integration code, so that they can
// refer to Module (if they choose; they can also define Module)
// include: C:\Users\User\Downloads\TOOLS\OTHER\UEWASM\runtime\web\uew_files.js
// Game files fetched on demand in 1 MB blocks (host_remote.c). data/index.txt lists every file;
// data/<id> is its first part and data/<id>.<n> the rest.
((() => {
  if (typeof ENVIRONMENT_IS_PTHREAD != "undefined" && ENVIRONMENT_IS_PTHREAD) return;
  // page-side only; worker threads skip it
  const BLOCK = 1 << 20;
  const F = Module.uewFiles = {
    base: Module.uewDataUrl || "data/",
    part: 16 << 20,
    cacheMax: (+new URLSearchParams(location.search).get("cachemb") || Module.uewCacheMB || 640) << 20,
    files: [],
    byPath: new Map,
    dirs: new Map,
    cache: new Map,
    cacheBytes: 0,
    pending: new Map,
    next: new Map,
    fetched: 0
  };
  const norm = p => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "").toLowerCase();
  const key = (id, b) => id * 1048576 + b;
  // something a green thread may be blocked on has finished: end an idle wait now instead of at its timer
  Module.uewWake = () => {
    const w = Module.uewIdleWake;
    if (w) {
      Module.uewIdleWake = null;
      w();
    }
  };
  F.load = text => {
    const lines = text.split(/\r?\n/);
    const head = lines[0].split(" ");
    if (head[0] != "uewasm-files") throw new Error("bad data/index.txt");
    F.part = +head[2];
    // keyed by the lowercased path; listings keep the names' own case (games build paths from what they list)
    const addDir = (orig, name, e) => {
      const p = norm(orig);
      let d = F.dirs.get(p);
      if (!d) {
        d = new Map;
        F.dirs.set(p, d);
        const i = orig.lastIndexOf("/");
        if (i >= 0) addDir(orig.slice(0, i), orig.slice(i + 1), {
          dir: true
        });
      }
      if (name && !d.has(name)) d.set(name, e);
    };
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const [size, mtime, flags, path, blocks] = lines[i].split("\t");
      const f = {
        id: F.files.length,
        size: +size,
        mtime: +mtime,
        stub: flags == "1",
        z: flags == "2",
        blocks
      };
      F.files.push(f);
      const n = norm(path);
      F.byPath.set(n, f);
      const j = path.lastIndexOf("/");
      addDir(path.slice(0, j), path.slice(j + 1), f);
    }
  };
  F.lookup = p => {
    p = norm(p);
    return F.byPath.get(p) || (F.dirs.has(p) ? {
      dir: true
    } : null);
  };
  F.list = p => {
    const d = F.dirs.get(norm(p));
    if (!d) return null;
    let s = "";
    for (const [name, e] of d) s += `${name}\t${e.dir ? 1 : 0}\t${e.size || 0}\t${e.mtime || 0}\n`;
    return s;
  };
  const get = k => {
    const v = F.cache.get(k);
    if (v) {
      F.cache.delete(k);
      F.cache.set(k, v);
    }
    return v;
  };
  F.seen = new Set;
  F.refetched = 0;
  // ?cachetrace=1: every block the game reads (its key) and every block that arrives (-key-1), in order, to replay
  // against other cache sizes and policies offline
  const TR = F.trace = new URLSearchParams(location.search).get("cachetrace") ? [] : null;
  const put = (k, buf) => {
    if (F.cache.has(k)) return;
    if (TR) TR.push(-k - 1);
    // a block downloaded before and evicted since: what a too-small cache costs
    if (F.seen.has(k)) F.refetched += buf.byteLength; else F.seen.add(k);
    F.cache.set(k, buf);
    F.cacheBytes += buf.byteLength;
    while (F.cacheBytes > F.cacheMax) {
      const [k0, v0] = F.cache.entries().next().value;
      F.cache.delete(k0);
      F.cacheBytes -= v0.byteLength;
    }
  };
  const name = (id, part) => part ? `${id}.${part}` : `${id}`;
  const url = (id, part) => F.base + name(id, part);
  // bytes [from, to) of one part (all of it when from is null): over HTTP, or from the page itself in a single-file build
  const E = Module.uewEmbed;
  const fetchPart = async (id, part, from, to) => {
    if (E) {
      const b = E.part(name(id, part));
      if (!b) throw new Error(`missing embedded part ${name(id, part)}`);
      return {
        status: from == null ? 200 : 206,
        buf: new Uint8Array(await (from == null ? b : b.slice(from, to)).arrayBuffer())
      };
    }
    const r = await fetch(url(id, part), from == null ? {} : {
      headers: {
        Range: `bytes=${from}-${to - 1}`
      }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url(id, part)}`);
    return {
      status: r.status,
      buf: new Uint8Array(await r.arrayBuffer())
    };
  };
  // where each block of a file sits: raw files are plain slices, deflated ones follow the size list in the index
  const layout = f => {
    if (f.L) return f.L;
    if (!f.z) {
      const per = F.part / BLOCK, n = Math.max(1, Math.ceil(f.size / BLOCK));
      f.L = Array.from({
        length: n
      }, (_, b) => (({
        part: Math.floor(b / per),
        off: (b % per) * BLOCK,
        len: Math.min(BLOCK, f.size - b * BLOCK)
      })));
    } else {
      let part = 0, used = 0;
      f.L = f.blocks.split(",").map(x => {
        const len = parseInt(x, 16);
        if (used && used + len > F.part) {
          part++;
          used = 0;
        }
        const e = {
          part,
          off: used,
          len
        };
        used += len;
        return e;
      });
    }
    return f.L;
  };
  const inflate = async buf => new Uint8Array(await new Response(new Blob([ buf ]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
  const unpack = (f, b, buf) => {
    const raw = Math.min(BLOCK, f.size - b * BLOCK);
    return f.z && buf.length != raw ? inflate(buf) : buf;
  };
  async function download(f, b) {
    if (f.stub) return new Uint8Array(Math.min(BLOCK, f.size - b * BLOCK));
    const L = layout(f), e = L[b];
    const whole = L.length == 1;
    for (let attempt = 0; ;attempt++) {
      try {
        const t0 = performance.now();
        F.inflight = (F.inflight || 0) + 1;
        F.maxInflight = Math.max(F.maxInflight || 0, F.inflight);
        const r = await fetchPart(f.id, e.part, whole ? null : e.off, e.off + e.len);
        let buf = r.buf;
        F.fetched += buf.length;
        F.requests = (F.requests || 0) + 1;
        F.inflight--;
        F.fetchMs = (F.fetchMs || 0) + performance.now() - t0;
        if (window.uewStats) {
          const st = (F.per || (F.per = new Map)), e = st.get(f.id) || {
            n: 0,
            bytes: 0,
            uniq: new Set
          };
          e.n++;
          e.bytes += buf.length;
          e.uniq.add(b);
          st.set(f.id, e);
        }
        if (!whole && r.status == 200) {
          // no Range support on this server: keep every block of the part
          for (let i = 0; i < L.length; i++) if (i != b && L[i].part == e.part && !F.cache.has(key(f.id, i))) put(key(f.id, i), await unpack(f, i, buf.slice(L[i].off, L[i].off + L[i].len)));
          buf = buf.slice(e.off, e.off + e.len);
        }
        return await unpack(f, b, buf);
      } catch (err_) {
        if (attempt >= 3) throw err_;
        await new Promise(r => setTimeout(r, 500 << attempt));
      }
    }
  }
  const block = (id, b) => {
    const k = key(id, b);
    const hit = get(k);
    if (hit) return hit;
    let p = F.pending.get(k);
    if (!p) {
      p = download(F.files[id], b).then(buf => {
        F.pending.delete(k);
        F.failed.delete(k);
        put(k, buf);
        Module.uewWake();
        return buf;
      }, e => {
        F.pending.delete(k);
        F.failed.add(k);
        Module.uewWake();
        throw e;
      });
      F.pending.set(k, p);
    }
    return p;
  };
  // several neighbouring blocks in one request (browsers allow only 6 at a time per server, so fewer, bigger ones win)
  const blocks = (id, b0, b1) => {
    const f = F.files[id];
    if (f.stub || b1 <= b0) {
      for (let b = b0; b <= b1; b++) {
        const r = block(id, b);
        if (r instanceof Promise) r.catch(() => {});
      }
      return;
    }
    const L = layout(f);
    if (L.length == 1) {
      const r = block(id, b0);
      if (r instanceof Promise) r.catch(() => {});
      return;
    }
    let run = [];
    const go = () => {
      if (!run.length) return;
      const bs = run;
      run = [];
      if (bs.length == 1) {
        block(id, bs[0]).catch(() => {});
        return;
      }
      const first = L[bs[0]], lastE = L[bs[bs.length - 1]], from = first.off, to = lastE.off + lastE.len;
      const all = ((async () => {
        for (let attempt = 0; ;attempt++) {
          try {
            const t0 = performance.now();
            const r = await fetchPart(f.id, first.part, from, to);
            let buf = r.buf;
            // a server without Range support sends the whole part
            if (r.status == 200 && buf.length >= to) buf = buf.slice(from, to);
            if (buf.length != to - from) throw new Error(`HTTP ${r.status}: ${buf.length} bytes for ${url(f.id, first.part)}`);
            F.fetched += buf.length;
            F.requests = (F.requests || 0) + 1;
            F.fetchMs = (F.fetchMs || 0) + performance.now() - t0;
            if (window.uewStats) {
              const st = (F.per || (F.per = new Map)), e = st.get(f.id) || {
                n: 0,
                bytes: 0,
                uniq: new Set
              };
              e.n++;
              e.bytes += buf.length;
              for (const b of bs) e.uniq.add(b);
              st.set(f.id, e);
            }
            return buf;
          } catch (err_) {
            if (attempt >= 3) throw err_;
            await new Promise(r => setTimeout(r, 500 << attempt));
          }
        }
      }))();
      for (const b of bs) {
        const k = key(id, b), e = L[b];
        const pr = all.then(buf => unpack(f, b, buf.slice(e.off - from, e.off - from + e.len))).then(v => {
          F.pending.delete(k);
          F.failed.delete(k);
          put(k, v);
          Module.uewWake();
          return v;
        }, e => {
          F.pending.delete(k);
          F.failed.add(k);
          Module.uewWake();
          throw e;
        });
        pr.catch(() => {});
        F.pending.set(k, pr);
      }
    };
    for (let b = b0; b <= b1; b++) {
      const k = key(id, b);
      if (F.cache.has(k) || F.pending.has(k)) {
        go();
        continue;
      }
      if (run.length && L[run[0]].part != L[b].part) go();
      run.push(b);
    }
    go();
  };
  const ahead = (id, off, len) => {
    const f = F.files[id], end = off + len;
    const seq = F.next.get(id) === off;
    F.next.set(id, end);
    if (!seq) return;
    const last = Math.floor((f.size - 1) / BLOCK), b = Math.floor(end / BLOCK);
    if (b <= last) blocks(id, b, Math.min(last, b + 7));
  };
  // boot plan: the blocks the game read up to its first few hundred frames, in order, kept from the last session.
  // The next boot fetches them a window ahead of the game (starting while the wasm is still compiling).
  const T = {
    key: "",
    seen: new Set,
    order: [],
    rec: true,
    plan: [],
    pos: 0,
    q: [],
    qset: new Set
  };
  const pump = () => {
    while (T.pos < T.plan.length && T.q.length < 160) {
      const [id, b0, n] = T.plan[T.pos++];
      if (!F.files[id]) continue;
      const last = Math.floor((F.files[id].size - 1) / BLOCK), b1 = Math.min(last, b0 + n - 1);
      blocks(id, b0, b1);
      for (let b = b0; b <= b1; b++) {
        const k = key(id, b);
        if (!T.qset.has(k)) {
          T.qset.add(k);
          T.q.push(k);
        }
      }
    }
  };
  const touch = (id, b0, b1) => {
    for (let b = b0; b <= b1; b++) {
      const k = key(id, b);
      if (TR) TR.push(k);
      // the game reached a planned block: everything planned before it is behind us too
      if (T.qset.has(k)) {
        let x;
        do {
          x = T.q.shift();
          T.qset.delete(x);
        } while (x !== k);
        pump();
      }
      if (T.rec && !T.seen.has(k)) {
        T.seen.add(k);
        T.order.push(k);
      }
    }
    if (T.rec && T.order.length > 2e4) save();
  };
  const save = () => {
    if (!T.rec) return;
    T.rec = false;
    const runs = [];
    for (const k of T.order) {
      const id = Math.floor(k / 1048576), b = k % 1048576, r = runs[runs.length - 1];
      if (r && r[0] === id && r[1] + r[2] === b) r[2]++; else runs.push([ id, b, 1 ]);
    }
    try {
      localStorage.setItem(T.key, runs.map(r => r.join(":")).join(","));
    } catch (e) {}
  };
  F.boot = () => {
    T.key = "uewBoot:" + location.pathname + ":" + F.files.length + ":" + F.files.reduce((a, f) => (a + f.size) % 1e15, 0);
    let saved = "";
    try {
      saved = localStorage.getItem(T.key) || "";
    } catch (e) {}
    // the game image is read whole at startup: fetch it now, alongside the code download and compile
    const img = !E && F.byPath.get("/image.bin");
    if (img && !saved) blocks(img.id, 0, Math.floor((img.size - 1) / BLOCK));
    T.plan = saved && !E ? saved.split(",").map(r => r.split(":").map(Number)) : [];
    pump();
    const t = setInterval(() => {
      if ((Module.uewPresents | 0) >= 300) {
        clearInterval(t);
        save();
      }
    }, 1e3);
  };
  const copy = (bufs, b0, off, len, dst) => {
    let done = 0;
    for (let i = 0; i < bufs.length; i++) {
      const s = i ? 0 : off - b0 * BLOCK, n = Math.min(bufs[i].length - s, len - done);
      (growMemViews(), HEAPU8).set(bufs[i].subarray(s, s + n), dst + done >>> 0);
      done += n;
    }
    return done;
  };
  F.readCached = (id, off, len, dst) => {
    if (!len) return 0;
    const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + len - 1) / BLOCK), bufs = [];
    for (let b = b0; b <= b1; b++) {
      const v = get(key(id, b));
      if (!v) return -1;
      bufs.push(v);
    }
    touch(id, b0, b1);
    ahead(id, off, len);
    return copy(bufs, b0, off, len, dst);
  };
  // non-blocking form for green threads: start the downloads, poll ready() (true once every block is in, or one failed)
  F.failed = new Set;
  F.start = (id, off, len) => {
    const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + len - 1) / BLOCK);
    // a miss in a big file (pak reads hop around): the blocks after it usually follow soon, fetch them in the same request
    const last = Math.floor((F.files[id].size - 1) / BLOCK);
    blocks(id, b0, Math.min(last, b1 + 7));
    touch(id, b0, b1);
    ahead(id, off, len);
  };
  F.ready = (id, off, len) => {
    const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + len - 1) / BLOCK);
    for (let b = b0; b <= b1; b++) {
      const k = key(id, b);
      if (F.failed.has(k)) return 1;
      if (!get(k)) return 0;
    }
    return 1;
  };
  // debug: which files were downloaded most, and how often blocks came down again after leaving the cache
  F.report = () => {
    const paths = new Map;
    for (const [p, f] of F.byPath) paths.set(f.id, p);
    return [ `boot plan ${T.plan.length} runs, at ${T.pos}, ${T.q.length} ahead, recorded ${T.order.length} blocks (${T.rec ? "still recording" : "saved"})`, `${F.requests} requests, ${(F.fetchMs / F.requests).toFixed(1)} ms each on average, up to ${F.maxInflight} at once` ].concat([ ...(F.per || []) ].sort((x, y) => y[1].bytes - x[1].bytes).slice(0, 15).map(([id, e]) => `${(e.bytes / 1048576).toFixed(0)} MB in ${e.n} (${e.uniq.size} distinct blocks of ${Math.ceil(F.files[id].size / BLOCK)}) ${paths.get(id)}`)).join("\n");
  };
  F.read = async (id, off, len, dst) => {
    const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + len - 1) / BLOCK), want = [];
    for (let b = b0; b <= b1; b++) want.push(block(id, b));
    touch(id, b0, b1);
    ahead(id, off, len);
    try {
      return copy(await Promise.all(want), b0, off, len, dst);
    } catch (e) {
      err(`[files] ${e.message}`);
      return -1;
    }
  };
  // the index (and the boot plan's downloads) start now, alongside the wasm download and compile
  const index = (E ? Promise.resolve(E.index) : fetch(F.base + "index.txt").then(r => r.ok ? r.text() : null)).then(t => {
    if (t) {
      F.load(t);
      F.boot();
    } else err("[files] no data/index.txt, game files unavailable");
  }).catch(e => err(`[files] ${e.message}`));
  Module.preRun = [].concat(Module.preRun || []);
  Module.preRun.push(() => {
    addRunDependency("uew-files");
    index.finally(() => removeRunDependency("uew-files"));
  });
}))();

// end include: C:\Users\User\Downloads\TOOLS\OTHER\UEWASM\runtime\web\uew_files.js
// include: C:\Users\User\Downloads\TOOLS\OTHER\UEWASM\runtime\web\uew_save.js
// The save folder lives in IndexedDB so progress and settings survive reloads.
((() => {
  if (typeof ENVIRONMENT_IS_PTHREAD != "undefined" && ENVIRONMENT_IS_PTHREAD) return;
  // page-side only; worker threads skip it
  const dir = Module.uewSave;
  if (!dir) return;
  let busy = false;
  const flush = () => {
    if (busy) return;
    busy = true;
    FS.syncfs(false, e => {
      busy = false;
      if (e) err(`[save] ${e}`);
    });
  };
  Module.preRun = [].concat(Module.preRun || []);
  Module.preRun.push(() => {
    FS.mkdirTree(dir);
    FS.mount(IDBFS, {}, dir);
    addRunDependency("uew-save");
    FS.syncfs(true, e => {
      if (e) err(`[save] ${e}`);
      // ?clearsave=path/in/the/save/folder deletes that file or folder first (a stale download cache, a broken save)
      const clear = typeof location != "undefined" && new URLSearchParams(location.search).get("clearsave");
      if (clear && !clear.split(/[\\/]/).includes("..")) {
        const rm = p => {
          let st;
          try {
            st = FS.stat(p);
          } catch (_) {
            return 0;
          }
          if (!FS.isDir(st.mode)) {
            FS.unlink(p);
            return 1;
          }
          let n = 0;
          for (const k of FS.readdir(p)) if (k != "." && k != "..") n += rm(p + "/" + k);
          FS.rmdir(p);
          return n;
        };
        const p = dir + "/" + clear.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
        out(`[save] cleared ${p}: ${rm(p)} files`);
        flush();
      }
      // tests: window.uewSeedFiles = { "path/under/the/save/folder": base64 } puts files in place before the game starts
      const seed = typeof window !== "undefined" && window.uewSeedFiles;
      if (seed) for (const [rel, b64] of Object.entries(seed)) {
        const p = dir + "/" + rel, bin = atob(b64), a = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
        FS.mkdirTree(p.slice(0, p.lastIndexOf("/")));
        FS.writeFile(p, a);
      }
      // settings the build asks for (Unreal quality, say): a marked block put back at the end of the file on each start.
      // A repeated key's last value wins, so it outranks what the game saved there itself
      for (const [rel, text] of Object.entries(Module.uewSeed || {})) {
        const p = dir + "/" + rel, b = "; UEWASM begin\n", e = "; UEWASM end\n";
        let old = "";
        try {
          old = FS.readFile(p, {
            encoding: "utf8"
          }).replace(/\r\n/g, "\n");
        } catch (_) {}
        const i = old.indexOf(b), j = old.indexOf(e);
        if (i >= 0 && j > i) old = old.slice(0, i) + old.slice(j + e.length);
        FS.mkdirTree(p.slice(0, p.lastIndexOf("/")));
        FS.writeFile(p, old + (old && !old.endsWith("\n") ? "\n" : "") + b + text + e);
      }
      removeRunDependency("uew-save");
      setInterval(flush, 5e3);
      addEventListener("pagehide", flush);
      addEventListener("visibilitychange", () => {
        if (document.visibilityState == "hidden") flush();
      });
    });
  });
}))();

// end include: C:\Users\User\Downloads\TOOLS\OTHER\UEWASM\runtime\web\uew_save.js
// include: C:\Users\User\Downloads\TOOLS\OTHER\UEWASM\runtime\web\uew_wisp.js
// Real network connections through a WISP server (github.com/MercuryWorkshop/wisp-protocol): TCP and UDP streams
// multiplexed over one WebSocket. With a WISP server configured (--wisp / --wisp-url at build time, ?wisp=URL in the page
// address, ?wisp=0 to turn it off) every host name and address the game uses that no offline backend takes goes out
// for real: the game's own HTTPS, the EOS SDK, game servers. TLS is the game's own (its OpenSSL), end to end, so the
// WISP server only relays encrypted bytes. The runtime's sockets reach this through Module.uewNet.wisp (uew_host.js).
((() => {
  if (typeof location === "undefined" || location.protocol === "file:") return;
  const q = new URLSearchParams(location.search);
  const cfg = Module.uewWisp || {};
  let url = q.has("wisp") ? q.get("wisp") : cfg.url || "";
  if (!url || url === "0") return;
  if (url === "origin") url = location.origin.replace(/^http/i, "ws") + "/wisp/";
  if (!/\/$/.test(url)) url += "/";
  const debug = /[?&]netdebug=1/.test(location.search);
  const TCP = 1, UDP = 2, CONNECT = 1, DATA = 2, CONTINUE = 3, CLOSE = 4;
  const enc = new TextEncoder;
  let ws = null, opened = false, initial = null, nextId = 1, waiting = [];
  const streams = new Map;
  function frame(type, id, payload) {
    const f = new Uint8Array(5 + payload.length);
    f[0] = type;
    new DataView(f.buffer).setUint32(1, id, true);
    f.set(payload, 5);
    return f;
  }
  function put(f) {
    if (opened) ws.send(f); else waiting.push(f);
  }
  function flush(s) {
    while (s.pending.length && s.buf > 0) {
      put(frame(DATA, s.id, s.pending.shift()));
      s.buf--;
    }
  }
  function end(s, why) {
    if (!streams.has(s.id)) return;
    streams.delete(s.id);
    if (debug) console.log(`[wisp] ${s.host}:${s.port} closed (${why})`);
    s.c.end();
  }
  function connect() {
    opened = false;
    initial = null;
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      opened = true;
      console.log("[wisp] connected to " + url);
      for (const f of waiting.splice(0)) ws.send(f);
    };
    ws.onmessage = e => {
      const d = new Uint8Array(e.data);
      if (d.length < 5) return;
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const type = d[0], id = dv.getUint32(1, true);
      if (type === CONTINUE) {
        const n = dv.getUint32(5, true);
        if (id === 0) {
          initial = n;
          for (const s of streams.values()) if (s.buf === null) {
            s.buf = n;
            flush(s);
          }
        } else {
          const s = streams.get(id);
          if (s) {
            s.buf = n;
            flush(s);
          }
        }
        return;
      }
      const s = streams.get(id);
      if (!s) return;
      if (type === DATA) s.c.push(d.slice(5)); else if (type === CLOSE) end(s, "reason 0x" + (d[5] || 0).toString(16));
    };
    ws.onclose = ws.onerror = () => {
      if (ws === null) return;
      const was = opened;
      ws = null;
      opened = false;
      if (!was) console.log("[wisp] can't reach " + url);
      for (const s of [ ...streams.values() ]) end(s, "WISP connection lost");
      waiting = [];
    };
  }
  Module.uewNet = Module.uewNet || {};
  Module.uewNet.wisp = {
    url,
    // everything but this machine: the server decides what it will reach
    ok: host => !/^(localhost|127\.|0\.0\.0\.0$|::1$)/i.test(host),
    open(host, port, udp) {
      if (!ws) connect();
      const id = nextId++;
      const c = {};
      const s = {
        id,
        host,
        port,
        udp,
        c,
        buf: udp ? Infinity : initial,
        pending: []
      };
      c.send = data => {
        if (!streams.has(id)) return;
        if (s.udp) put(frame(DATA, id, data)); else {
          s.pending.push(data);
          if (s.buf !== null) flush(s);
        }
      };
      c.close = () => {
        if (!streams.has(id)) return;
        streams.delete(id);
        put(frame(CLOSE, id, Uint8Array.of(2)));
      };
      streams.set(id, s);
      const name = enc.encode(host);
      const p = new Uint8Array(3 + name.length);
      p[0] = udp ? UDP : TCP;
      p[1] = port & 255;
      p[2] = port >> 8;
      p.set(name, 3);
      put(frame(CONNECT, id, p));
      if (debug) console.log(`[wisp] open ${udp ? "udp" : "tcp"} ${host}:${port}`);
      return c;
    }
  };
}))();

// end include: C:\Users\User\Downloads\TOOLS\OTHER\UEWASM\runtime\web\uew_wisp.js
// include: C:\Users\User\Downloads\TOOLS\OTHER\UEWASM\runtime\web\uew_debug.js
// Debug panel: \ or Insert shows it. Live numbers, switches that apply on reload, and tools that save a log, dump the
// green threads or capture a frame to a file.
((() => {
  if (typeof ENVIRONMENT_IS_PTHREAD != "undefined" && ENVIRONMENT_IS_PTHREAD) return;
  // page-side only; worker threads skip it
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const q = new URLSearchParams(location.search);
  if (q.get("capture") === "1") window.uewCaptureFrame = 1 << 30;
  // every console line, so the whole session can be saved even when the console drops or truncates it
  const lines = [];
  const keep = args => {
    lines.push(`${(performance.now() / 1e3).toFixed(1)} ${Array.from(args).map(a => typeof a === "string" ? a : String(a)).join(" ")}`);
    if (lines.length > 2e5) lines.splice(0, 5e4);
  };
  for (const k of [ "log", "warn", "error" ]) {
    const orig = console[k].bind(console);
    console[k] = (...a) => {
      keep(a);
      orig(...a);
    };
  }
  const save = (name, text, type) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([ text ], {
      type
    }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5e3);
  };
  const stamp = () => (new Date).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const SWITCHES = [ [ "swvideo", "Software video decoding" ], [ "syncshaders", "Compile shaders when first drawn" ], [ "skipshaders", "Drop draws while shaders compile (can lose effects)" ], [ "syncreadback", "Wait for every GPU readback" ], [ "noresolve", "Skip ResolveSubresource" ], [ "capture", "Enable frame capture" ] ];
  let panel = null, timer = 0;
  // UE developer console: the runtime attaches UE's own console to the game viewport once the engine is up, so it retries
  // until then. The result line comes from the runtime log.
  const conAuto = () => {
    try {
      return localStorage.getItem("uewConsole") === "1";
    } catch (e) {
      return false;
    }
  };
  let conTimer = 0;
  const console_on = say => {
    if (conTimer) return;
    let tries = 0;
    const go = () => {
      if (!window.Module || !Module._uew_ue_console) return;
      const ok = Module._uew_ue_console();
      const last = lines.filter(l => l.includes("[ue console]")).pop() || "";
      say && say(last.replace(/.*\[ue console\] /, "UE console: "));
      if (ok || ++tries > 60) {
        clearInterval(conTimer);
        conTimer = 0;
      }
    };
    conTimer = setInterval(go, 3e3);
    go();
  };
  // after a reload the panel may never be opened: start it from here when asked to
  if (conAuto()) setTimeout(() => console_on(null), 5e3);
  const css = `#uewdbg{position:fixed;right:8px;top:8px;z-index:10;width:360px;max-height:calc(100% - 16px);overflow:auto;\n    background:#101418ee;color:#dde;border:1px solid #3a4652;border-radius:6px;font:12px ui-monospace,Consolas,monospace;padding:10px}\n    #uewdbg h3{margin:0 0 6px;font:600 13px system-ui,sans-serif;color:#9fd}#uewdbg button{font:12px system-ui,sans-serif;margin:2px 4px 2px 0;\n    padding:4px 8px;background:#243040;color:#dde;border:1px solid #3a4652;border-radius:4px;cursor:pointer}#uewdbg button:hover{background:#2e3e52}\n    #uewdbg label{display:block;margin:2px 0;cursor:pointer}#uewdbg pre{white-space:pre-wrap;margin:4px 0;color:#bbc;font-size:11px}\n    #uewdbg .sec{margin-top:8px;border-top:1px solid #2a343e;padding-top:6px}`;
  const build = () => {
    const st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);
    panel = document.createElement("div");
    panel.id = "uewdbg";
    panel.innerHTML = `<h3>UEWASM debug <span style="color:#778;font-weight:400">(\\ or Insert closes)</span></h3>\n      <pre id="uewdbg-live">…</pre>\n      <div class="sec"><b>Game speed</b> (sound is muted above 1x)<br>\n        ${[ 1, 2, 4, 8 ].map(v => `<button data-speed="${v}">${v}x</button>`).join("")}</div>\n      <div class="sec"><b>Unreal Engine</b><br>\n        <button id="uewdbg-con">Enable UE dev console</button>\n        <label><input type="checkbox" id="uewdbg-conauto"> Enable it on every launch</label></div>\n      <div class="sec"><b>Switches</b> (apply on reload)\n        ${SWITCHES.map(([k, t]) => `<label><input type="checkbox" data-k="${k}" ${q.get(k) === "1" ? "checked" : ""}> ${t}</label>`).join("")}\n        <button id="uewdbg-reload">Reload with these</button></div>\n      <div class="sec"><b>Tools</b><br>\n        <button id="uewdbg-log">Save log</button><button id="uewdbg-thr">Dump threads</button><button id="uewdbg-cap">Capture frame</button>\n        <br><button id="uewdbg-sexp">Export saves</button><button id="uewdbg-simp">Import saves</button>\n        <input id="uewdbg-sfile" type="file" accept=".json" style="display:none">\n        <pre id="uewdbg-msg"></pre></div>\n      <div class="sec"><b>Recent hitches</b><pre id="uewdbg-hitch"></pre></div>`;
    document.body.appendChild(panel);
    for (const ev of [ "mousedown", "mouseup", "click", "keydown", "keyup", "wheel" ]) panel.addEventListener(ev, e => e.stopPropagation());
    const msg = t => {
      panel.querySelector("#uewdbg-msg").textContent = t;
    };
    for (const b of panel.querySelectorAll("button[data-speed]")) b.onclick = () => {
      if (!window.Module || !Module._uew_set_speed) return msg("game not running yet");
      Module._uew_set_speed(+b.dataset.speed);
      window.uewSpeed = +b.dataset.speed;
      msg(`game speed ${b.dataset.speed}x`);
    };
    const auto = panel.querySelector("#uewdbg-conauto");
    auto.checked = conAuto();
    auto.onchange = () => {
      try {
        localStorage.setItem("uewConsole", auto.checked ? "1" : "");
      } catch (e) {}
      if (auto.checked) console_on(msg);
    };
    panel.querySelector("#uewdbg-con").onclick = () => console_on(msg);
    panel.querySelector("#uewdbg-reload").onclick = () => {
      const p = new URLSearchParams(location.search);
      for (const box of panel.querySelectorAll("input[data-k]")) box.checked ? p.set(box.dataset.k, "1") : p.delete(box.dataset.k);
      location.search = p.toString();
    };
    panel.querySelector("#uewdbg-log").onclick = () => {
      save(`uewasm-log-${stamp()}.txt`, lines.join("\n"), "text/plain");
      msg(`saved ${lines.length} lines`);
    };
    panel.querySelector("#uewdbg-thr").onclick = () => {
      if (!window.Module || !Module._uew_threads) return msg("game not running yet");
      Module._uew_threads();
      msg("thread list written to the log (Save log to keep it)");
    };
    // the whole save folder (game saves and settings) as one JSON file, and back
    panel.querySelector("#uewdbg-sexp").onclick = () => {
      const root = window.Module && Module.uewSave;
      if (!root || typeof FS === "undefined") return msg("no save folder");
      const out = {};
      const walk = d => {
        for (const n of FS.readdir(d)) {
          if (n === "." || n === "..") continue;
          const p = d + "/" + n;
          if (FS.isDir(FS.stat(p).mode)) walk(p); else {
            const b = FS.readFile(p);
            let s = "";
            for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768));
            out[p.slice(root.length + 1)] = btoa(s);
          }
        }
      };
      walk(root);
      save(`uewasm-saves-${stamp()}.json`, JSON.stringify(out), "application/json");
      msg(`exported ${Object.keys(out).length} files`);
    };
    const pick = panel.querySelector("#uewdbg-sfile");
    panel.querySelector("#uewdbg-simp").onclick = () => pick.click();
    pick.onchange = async () => {
      const f = pick.files[0];
      if (!f) return;
      const root = Module.uewSave, files = JSON.parse(await f.text());
      for (const [rel, b64] of Object.entries(files)) {
        const p = root + "/" + rel, bin = atob(b64), a = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
        FS.mkdirTree(p.slice(0, p.lastIndexOf("/")));
        FS.writeFile(p, a);
      }
      msg(`imported ${Object.keys(files).length} files; reloading`);
      FS.syncfs(false, () => location.reload());
    };
    panel.querySelector("#uewdbg-cap").onclick = () => {
      const g = window.Module && Module.uewg;
      if (!g) return msg("game not running yet");
      if (q.get("capture") !== "1") return msg("tick 'Enable frame capture' and reload first");
      Module.uewgCaptured = null;
      window.uewCaptureFrame = g.frames + 3;
      msg("capturing…");
      const wait = setInterval(() => {
        if (!Module.uewgCaptured) return;
        clearInterval(wait);
        save(`uewasm-frame-${stamp()}.json`, JSON.stringify(Module.uewgCaptured), "application/json");
        msg("frame saved");
      }, 250);
    };
  };
  let lastN = 0, lastT = performance.now();
  const refresh = () => {
    if (!panel || panel.style.display === "none") return;
    const now = performance.now(), n = (window.Module && Module.uewPresents) || 0;
    const fps = (n - lastN) * 1e3 / Math.max(1, now - lastT);
    lastN = n;
    lastT = now;
    const g = window.Module && Module.uewg, V = window.Module && Module.uewVpx;
    const gpu = (lines.find(l => l.includes("[webgpu] GPU:")) || "").replace(/.*GPU: /, "").replace(/;.*/, "") || "?";
    const heap = typeof (growMemViews(), HEAPU8) !== "undefined" ? ((growMemViews(), 
    HEAPU8).length / 1048576).toFixed(0) + " MB" : "?";
    panel.querySelector("#uewdbg-live").textContent = `FPS ${fps.toFixed(0)}   frames ${n}\nGPU ${gpu}${g && g.lost ? `\nGPU DEVICE LOST (${g.lost.reason}): reload the page` : ""}\nshaders compiling ${g ? g.pendingPipes || 0 : 0}   draws skipped ${g && g.skip ? g.skip.nopipe : 0}\n` + `speed ${window.uewSpeed || 1}x\n` + `video ${V ? `hardware, ${V.s.size} open stream(s)` : q.get("swvideo") === "1" ? "software (switch)" : "software"}\nwasm memory ${heap}`;
    panel.querySelector("#uewdbg-hitch").textContent = lines.filter(l => l.includes("[hitch]") || l.includes("[watchdog]")).slice(-6).join("\n") || "none";
  };
  const toggle = () => {
    if (!panel) build(); else panel.style.display = panel.style.display === "none" ? "" : "none";
    clearInterval(timer);
    if (panel.style.display !== "none") {
      refresh();
      timer = setInterval(refresh, 500);
    }
  };
  addEventListener("keydown", e => {
    if (window.Module && Module.uewDebugPanel === false) return;
    if (e.code === "Backslash" || e.code === "Insert") {
      toggle();
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
  addEventListener("keyup", e => {
    if (window.Module && Module.uewDebugPanel === false) return;
    if (e.code === "Backslash" || e.code === "Insert") {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
}))();

// end include: C:\Users\User\Downloads\TOOLS\OTHER\UEWASM\runtime\web\uew_debug.js
var programArgs = [];

var thisProgram = "./this.program";

var quit_ = (status, toThrow) => {
  throw toThrow;
};

// In MODULARIZE mode _scriptName needs to be captured already at the very top of the page immediately when the page is parsed, so it is generated there
// before the page load. In non-MODULARIZE modes generate it here.
var _scriptName = globalThis.document?.currentScript?.src;

if (typeof __filename !== "undefined") {
  // Node
  _scriptName = __filename;
} else if (ENVIRONMENT_IS_WORKER) {
  _scriptName = self.location.href;
}

// `/` should be present at the end if `scriptDirectory` is not empty
var scriptDirectory = "";

function locateFile(path) {
  if (Module["locateFile"]) {
    return Module["locateFile"](path, scriptDirectory);
  }
  return scriptDirectory + path;
}

// Hooks that are implemented differently in different runtime environments.
var readAsync, readBinary;

if (ENVIRONMENT_IS_NODE) {
  // These modules will usually be used on Node.js. Load them eagerly to avoid
  // the complexity of lazy-loading.
  var fs = require("node:fs");
  scriptDirectory = __dirname + "/";
  // include: node_shell_read.js
  readBinary = filename => {
    // We need to re-wrap `file://` strings to URLs.
    filename = isFileURI(filename) ? new URL(filename) : filename;
    var ret = fs.readFileSync(filename);
    return ret;
  };
  readAsync = async (filename, binary = true) => {
    // See the comment in the `readBinary` function.
    filename = isFileURI(filename) ? new URL(filename) : filename;
    var ret = fs.readFileSync(filename, binary ? undefined : "utf8");
    return ret;
  };
  // end include: node_shell_read.js
  if (process.argv.length > 1) {
    thisProgram = process.argv[1].replace(/\\/g, "/");
  }
  programArgs = process.argv.slice(2);
  // MODULARIZE will export the module in the proper place outside, we don't need to export here
  if (typeof module !== "undefined") {
    module["exports"] = Module;
  }
  quit_ = (status, toThrow) => {
    process.exitCode = status;
    throw toThrow;
  };
} else // Note that this includes Node.js workers when relevant (pthreads is enabled).
// Node.js workers are detected as a combination of ENVIRONMENT_IS_WORKER and
// ENVIRONMENT_IS_NODE.
if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
  try {
    scriptDirectory = new URL(".", _scriptName).href;
  } catch {}
  // Differentiate the Web Worker from the Node Worker case, as reading must
  // be done differently.
  if (!ENVIRONMENT_IS_NODE) {
    // include: web_or_worker_shell_read.js
    if (ENVIRONMENT_IS_WORKER) {
      readBinary = url => {
        var xhr = new XMLHttpRequest;
        xhr.open("GET", url, false);
        xhr.responseType = "arraybuffer";
        xhr.send(null);
        return new Uint8Array(/** @type{!ArrayBuffer} */ (xhr.response));
      };
    }
    readAsync = async url => {
      var response = await fetch(url, {
        credentials: "same-origin"
      });
      if (response.ok) {
        return response.arrayBuffer();
      }
      throw new Error(response.status + " : " + response.url);
    };
  }
} else {}

// Set up the out() and err() hooks, which are how we can print to stdout or
// stderr, respectively.
// Normally just binding console.log/console.error here works fine, but
// under node (with workers) we see missing/out-of-order messages so route
// directly to stdout and stderr.
// See https://github.com/emscripten-core/emscripten/issues/14804
var defaultPrint = console.log.bind(console);

var defaultPrintErr = console.error.bind(console);

if (ENVIRONMENT_IS_NODE) {
  var utils = require("node:util");
  var stringify = a => typeof a === "object" ? utils.inspect(a) : a;
  defaultPrint = (...args) => fs.writeSync(1, args.map(stringify).join(" ") + "\n");
  defaultPrintErr = (...args) => fs.writeSync(2, args.map(stringify).join(" ") + "\n");
}

var out = defaultPrint;

var err = defaultPrintErr;

// end include: shell.js
// include: preamble.js
// === Preamble library stuff ===
// Documentation for the public APIs defined in this file must be updated in:
//    site/source/docs/api_reference/preamble.js.rst
// A prebuilt local version of the documentation is available at:
//    site/build/text/docs/api_reference/preamble.js.txt
// You can also build docs locally as HTML or other formats in site/
// An online HTML version (which may be of a different version of Emscripten)
//    is up at http://kripken.github.io/emscripten-site/docs/api_reference/preamble.js.html
var wasmBinary;

// Wasm globals
// For sending to workers.
var wasmModule;

//========================================
// Runtime essentials
//========================================
// whether we are quitting the application. no code should run after this.
// set in exit() and abort()
var ABORT = false;

// set by exit() and abort().  Passed to 'onExit' handler.
// NOTE: This is also used as the process return code in shell environments
// but only when noExitRuntime is false.
var EXITSTATUS;

// In STRICT mode, we only define assert() when ASSERTIONS is set.  i.e. we
// don't define it at all in release modes.  This matches the behaviour of
// MINIMAL_RUNTIME.
// TODO(sbc): Make this the default even without STRICT enabled.
/** @type {function(*, string=)} */ function assert(condition, text) {
  if (!condition) {
    // This build was created without ASSERTIONS defined.  `assert()` should not
    // ever be called in this configuration but in case there are callers in
    // the wild leave this simple abort() implementation here for now.
    abort(text);
  }
}

/**
 * Indicates whether filename is delivered via file protocol (as opposed to http/https)
 * @noinline
 */ var isFileURI = filename => filename.startsWith("file://");

// include: runtime_common.js
// include: runtime_exceptions.js
// Base Emscripten EH error class
class EmscriptenEH {}

// end include: runtime_exceptions.js
// include: runtime_debug.js
// end include: runtime_debug.js
// Support for growable heap + pthreads, where the buffer may change, so JS views
// must be updated.
function growMemViews() {
  // `updateMemoryViews` updates all the views simultaneously, so it's enough to check any of them.
  if (wasmMemory.buffer != HEAP8.buffer) {
    updateMemoryViews();
  }
}

if (ENVIRONMENT_IS_NODE && (ENVIRONMENT_IS_PTHREAD)) {
  // Create as web-worker-like an environment as we can.
  globalThis.self = globalThis;
  var parentPort = worker_threads.parentPort;
  // Deno and Bun already have `postMessage` defined on the global scope and
  // deliver messages to `globalThis.onmessage`, so we must not duplicate that
  // behavior here if `postMessage` is already present.
  if (!globalThis.postMessage) {
    parentPort.on("message", msg => globalThis.onmessage?.({
      data: msg
    }));
    globalThis.postMessage = msg => parentPort.postMessage(msg);
  }
  // Node.js Workers do not pass postMessage()s and uncaught exception events to the parent
  // thread necessarily in the same order where they were generated in sequential program order.
  // See https://github.com/nodejs/node/issues/59617
  // To remedy this, capture all uncaughtExceptions in the Worker, and sequentialize those over
  // to the same postMessage pipe that other messages use.
  process.on("uncaughtException", err => {
    postMessage({
      cmd: CMD_UNCAUGHT_EXN,
      error: err
    });
    // Also shut down the Worker to match the same semantics as if this uncaughtException
    // handler was not registered.
    // (n.b. this will not shut down the whole Node.js app process, but just the Worker)
    process.exit(1);
  });
}

// Memory management
var runtimeInitialized = false;

var runtimeExited = false;

// When ALLOW_MEMORY_GROWTH is enabled, the conversion from Wasm
// memory to ArrayBuffer requires some additional logic.
function getMemoryBuffer() {
  return wasmMemory.buffer;
}

function updateMemoryViews() {
  // If we already have a heap that is resizeable/growable buffer we don't
  // need to do anything in updateMemoryViews.
  if (HEAP8?.buffer?.growable) return;
  var b = getMemoryBuffer();
  HEAP8 = new Int8Array(b);
  HEAP16 = new Int16Array(b);
  HEAPU8 = new Uint8Array(b);
  HEAPU16 = new Uint16Array(b);
  HEAP32 = new Int32Array(b);
  HEAPU32 = new Uint32Array(b);
  HEAPF32 = new Float32Array(b);
  HEAPF64 = new Float64Array(b);
  HEAP64 = new BigInt64Array(b);
}

// In non-standalone/normal mode, we create the memory here.
// include: runtime_init_memory.js
// Create the wasm memory. (Note: this only applies if IMPORTED_MEMORY is defined)
function initMemory() {
  if ((ENVIRONMENT_IS_PTHREAD)) {
    return;
  }
  {
    var INITIAL_MEMORY = 67108864;
    /** @suppress {checkTypes} */ wasmMemory = new WebAssembly.Memory({
      "initial": INITIAL_MEMORY / 65536,
      // In theory we should not need to emit the maximum if we want "unlimited"
      // or 4GB of memory, but VMs error on that atm, see
      // https://github.com/emscripten-core/emscripten/issues/14130
      // And in the pthreads case we definitely need to emit a maximum. So
      // always emit one.
      "maximum": 65536,
      "shared": true
    });
  }
  updateMemoryViews();
}

// end include: runtime_init_memory.js
// include: memoryprofiler.js
// end include: memoryprofiler.js
// end include: runtime_common.js
function preRun() {
  var preRun = Module["preRun"];
  if (preRun) {
    if (typeof preRun === "function") preRun = [ preRun ];
    onPreRuns.push(...preRun);
  }
  // Begin ATPRERUNS hooks
  callRuntimeCallbacks(onPreRuns);
}

function initRuntime() {
  runtimeInitialized = true;
  if (ENVIRONMENT_IS_PTHREAD) return;
  // Begin ATINITS hooks
  if (!Module["noFSInit"] && !FS.initialized) FS.init();
  TTY.init();
  // End ATINITS hooks
  wasmExports["__wasm_call_ctors"]();
  // Begin ATPOSTCTORS hooks
  FS.ignorePermissions = false;
}

function exitRuntime() {
  ___funcs_on_exit();
  // Native atexit() functions
  // Begin ATEXITS hooks
  FS.quit();
  IDBFS.quit();
  TTY.shutdown();
  // End ATEXITS hooks
  PThread.terminateRuntime();
  runtimeExited = true;
}

function postRun() {
  var postRun = Module["postRun"];
  if (postRun) {
    if (typeof postRun === "function") postRun = [ postRun ];
    onPostRuns.push(...postRun);
  }
  // Begin ATPOSTRUNS hooks
  callRuntimeCallbacks(onPostRuns);
}

/**
 * @param {string|number=} what
 */ function abort(what) {
  Module["onAbort"]?.(what);
  what = `Aborted(${what})`;
  // TODO(sbc): Should we remove printing and leave it up to whoever
  // catches the exception?
  err(what);
  ABORT = true;
  what += ". Build with -sASSERTIONS for more info.";
  // Use a wasm runtime error, because a JS error might be seen as a foreign
  // exception, which means we'd run destructors on it. We need the error to
  // simply make the program stop.
  // FIXME This approach does not work in Wasm EH because it currently does not assume
  // all RuntimeErrors are from traps; it decides whether a RuntimeError is from
  // a trap or not based on a hidden field within the object. So at the moment
  // we don't have a way of throwing a wasm trap from JS. TODO Make a JS API that
  // allows this in the wasm spec.
  throw new WebAssembly.RuntimeError(what);
}

var wasmBinaryFile;

function findWasmBinary() {
  return locateFile("game.wasm");
}

function getBinarySync(file) {
  if (readBinary) {
    return readBinary(file);
  }
  // Throwing a plain string here, even though it not normally advisable since
  // this gets turning into an `abort` in instantiateArrayBuffer.
  throw "both async and sync fetching of the wasm failed";
}

async function getWasmBinary(binaryFile) {
  // If we don't have the binary yet, load it asynchronously using readAsync.
  if (!wasmBinary) {
    // Fetch the binary using readAsync
    try {
      // Await so a rejection is caught and falls back to getBinarySync.
      return await readAsync(binaryFile);
    } catch {}
  }
  // Otherwise, getBinarySync should be able to get it synchronously
  return getBinarySync(binaryFile);
}

async function instantiateArrayBuffer(binaryFile, imports) {
  try {
    var binary = await getWasmBinary(binaryFile);
    var instance = await WebAssembly.instantiate(binary, imports);
    return instance;
  } catch (reason) {
    err(`failed to asynchronously prepare wasm: ${reason}`);
    abort(reason);
  }
}

async function instantiateAsync(binary, binaryFile, imports) {
  if (!binary && !ENVIRONMENT_IS_NODE) {
    try {
      var response = fetch(binaryFile, {
        credentials: "same-origin"
      });
      var instantiationResult = await WebAssembly.instantiateStreaming(response, imports);
      return instantiationResult;
    } catch (reason) {
      // We expect the most common failure cause to be a bad MIME type for the binary,
      // in which case falling back to ArrayBuffer instantiation should work.
      err(`wasm streaming compile failed: ${reason}`);
      err("falling back to ArrayBuffer instantiation");
    }
  }
  return instantiateArrayBuffer(binaryFile, imports);
}

function getWasmImports() {
  assignWasmImports();
  // instrumenting imports is used in asyncify in two ways: to add assertions
  // that check for proper import use, and for JSPI we use them to set up
  // the Promise API on the import side.
  // In pthreads builds getWasmImports is called more than once but we only
  // and the instrument the imports once.
  if (!wasmImports.__instrumented) {
    wasmImports.__instrumented = true;
    Asyncify.instrumentWasmImports(wasmImports);
  }
  // prepare imports
  var imports = {
    "env": wasmImports,
    "wasi_snapshot_preview1": wasmImports
  };
  return imports;
}

// Create the wasm instance.
// Receives the wasm imports, returns the exports.
async function createWasm() {
  // Load the wasm module and create an instance of using native support in the JS engine.
  // handle a generated wasm instance, receiving its exports and
  // performing other necessary setup
  function receiveInstance(instance, module) {
    wasmExports = instance.exports;
    wasmExports = Asyncify.instrumentWasmExports(wasmExports);
    wasmExports = applySignatureConversions(wasmExports);
    registerTLSInit(wasmExports["_emscripten_tls_init"]);
    assignWasmExports(wasmExports);
    // We now have the Wasm module loaded up, keep a reference to the compiled module so we can post it to the workers.
    wasmModule = module;
    return wasmExports;
  }
  // Prefer streaming instantiation if available.
  function receiveInstantiationResult(result) {
    // 'result' is a ResultObject object which has both the module and instance.
    // receiveInstance() will swap in the exports (to Module.asm) so they can be called
    return receiveInstance(result["instance"], result["module"]);
  }
  var info = getWasmImports();
  // User shell pages can write their own Module.instantiateWasm = function(imports, successCallback) callback
  // to manually instantiate the Wasm module themselves. This allows pages to
  // run the instantiation parallel to any other async startup actions they are
  // performing.
  // Also pthreads and wasm workers initialize the wasm instance through this
  // path.
  var instantiateWasm = Module["instantiateWasm"];
  if (instantiateWasm) {
    return new Promise(resolve => {
      instantiateWasm(info, (inst, mod) => resolve(receiveInstance(inst, mod)));
    });
  }
  if ((ENVIRONMENT_IS_PTHREAD)) {
    // Instantiate from the module that was received via postMessage from
    // the main thread. We can just use sync instantiation in the worker.
    var instance = new WebAssembly.Instance(wasmModule, getWasmImports());
    return receiveInstance(instance, wasmModule);
  }
  wasmBinaryFile ??= findWasmBinary();
  var result = await instantiateAsync(wasmBinary, wasmBinaryFile, info);
  var exports = receiveInstantiationResult(result);
  return exports;
}

// end include: preamble.js
// Begin JS library code
const CMD_CALL_HANDLER = 9;

const CMD_CHECK_MAILBOX = 4;

const CMD_LOAD = 1;

const CMD_LOADED = 3;

const CMD_RUN = 2;

const CMD_UNCAUGHT_EXN = 8;

class ExitStatus {
  name="ExitStatus";
  constructor(status) {
    this.message = `Program terminated with exit(${status})`;
    this.status = status;
  }
}

/** @type {!Int8Array} */ var HEAP8;

const CMD_CLEANUP_THREAD = 6;

const CMD_SPAWN_THREAD = 5;

/** @type {!Int32Array} */ var HEAP32;

var callRuntimeCallbacks = callbacks => {
  while (callbacks.length > 0) {
    // Pass the module as the first argument.
    callbacks.shift()(Module);
  }
};

var onPreRuns = [];

var addOnPreRun = cb => onPreRuns.push(cb);

var dependenciesPromise = null;

var dependenciesPromiseResolve = null;

var resolveRunDependencies = async () => dependenciesPromise;

var runDependencies = 0;

var removeRunDependency = id => {
  runDependencies--;
  Module["monitorRunDependencies"]?.(runDependencies);
  if (!runDependencies) {
    dependenciesPromiseResolve();
  }
};

var addRunDependency = id => {
  if (!runDependencies) {
    dependenciesPromise = new Promise(resolve => dependenciesPromiseResolve = resolve);
  }
  runDependencies++;
  Module["monitorRunDependencies"]?.(runDependencies);
};

var handleException = e => {
  // Certain exception types we do not treat as errors since they are used for
  // internal control flow.
  // 1. ExitStatus, which is thrown by exit()
  // 2. "unwind", which is thrown by emscripten_unwind_to_js_event_loop() and others
  //    that wish to return to JS event loop.
  if (e instanceof ExitStatus || e == "unwind") {
    return EXITSTATUS;
  }
  quit_(1, e);
};

var runtimeKeepaliveCounter = 0;

var keepRuntimeAlive = () => noExitRuntime || runtimeKeepaliveCounter > 0;

/** not-@type {!BigInt64Array} */ var HEAP64;

/** @type {!Float64Array} */ var HEAPF64;

var stackAlloc = sz => __emscripten_stack_alloc(sz);

var stackRestore = val => __emscripten_stack_restore(val);

var stackSave = () => _emscripten_stack_get_current();

/** @type{function(number, (number|boolean), ...number)} */ var proxyToMainThread = (funcIndex, emAsmAddr, proxyMode, ...callArgs) => {
  // EM_ASM proxying is done by passing a pointer to the address of the EM_ASM
  // content as `emAsmAddr`.  JS library proxying is done by passing an index
  // into `proxiedJSCallArgs` as `funcIndex`. If `emAsmAddr` is non-zero then
  // `funcIndex` will be ignored.
  // Additional arguments are passed after the first three are the actual
  // function arguments.
  // The serialization buffer contains the number of call params, and then
  // all the args here.
  // We also pass 'proxyMode' to C separately, since C needs to look at it.
  // Allocate a buffer (on the stack), which will be copied if necessary by
  // the C code.
  // First passed parameter specifies the number of arguments to the function.
  // When BigInt support is enabled, we must handle types in a more complex
  // way, detecting at runtime if a value is a BigInt or not (as we have no
  // type info here). To do that, add a "prefix" before each value that
  // indicates if it is a BigInt, which effectively doubles the number of
  // values we serialize for proxying. TODO: pack this?
  var bufSize = 8 * callArgs.length * 2;
  var sp = stackSave();
  var args = stackAlloc(bufSize);
  var b = ((args) >>> 3);
  for (var arg of callArgs) {
    if (typeof arg === "bigint") {
      // The prefix is non-zero to indicate a bigint.
      (growMemViews(), HEAP64)[b++ >>> 0] = 1n;
      (growMemViews(), HEAP64)[b++ >>> 0] = arg;
    } else {
      // The prefix is zero to indicate a JS Number.
      (growMemViews(), HEAP64)[b++ >>> 0] = 0n;
      (growMemViews(), HEAPF64)[b++ >>> 0] = arg;
    }
  }
  var rtn = __emscripten_run_js_on_main_thread(funcIndex, emAsmAddr, bufSize, args, proxyMode);
  stackRestore(sp);
  return rtn;
};

function exitOnMainThread(returnCode) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(0, 0, 0, returnCode);
  _exit(returnCode);
}

function _proc_exit(code) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(1, 0, 1, code);
  EXITSTATUS = code;
  if (!keepRuntimeAlive()) {
    PThread.terminateAllThreads();
    Module["onExit"]?.(code);
    ABORT = true;
  }
  quit_(code, new ExitStatus(code));
}

/** @param {boolean|number=} implicit */ var exitJS = (status, implicit) => {
  EXITSTATUS = status;
  if (ENVIRONMENT_IS_PTHREAD) {
    // implicit exit can never happen on a pthread
    // When running in a pthread we propagate the exit back to the main thread
    // where it can decide if the whole process should be shut down or not.
    // The pthread may have decided not to exit its own runtime, for example
    // because it runs a main loop, but that doesn't affect the main thread.
    exitOnMainThread(status);
    throw "unwind";
  }
  if (!keepRuntimeAlive()) {
    exitRuntime();
  }
  _proc_exit(status);
};

var maybeExit = () => {
  if (runtimeExited) {
    return;
  }
  if (!keepRuntimeAlive()) {
    try {
      if (ENVIRONMENT_IS_PTHREAD) {
        // exit the current thread, but only if there is one active.
        // TODO(https://github.com/emscripten-core/emscripten/issues/25076):
        // Unify this check with the runtimeExited check above
        if (_pthread_self()) __emscripten_thread_exit(EXITSTATUS);
        return;
      }
      _exit(EXITSTATUS);
    } catch (e) {
      handleException(e);
    }
  }
};

var callUserCallback = (func, ...args) => {
  if (runtimeExited || ABORT) {
    return;
  }
  try {
    return func(...args);
  } catch (e) {
    handleException(e);
  } finally {
    maybeExit();
  }
};

var waitAsyncPolyfilled = !Atomics.waitAsync;

function __emscripten_thread_mailbox_await(pthread_ptr) {
  pthread_ptr >>>= 0;
  if (!waitAsyncPolyfilled) {
    // Wait on the pthread's initial self-pointer field because it is easy and
    // safe to access from sending threads that need to notify the waiting
    // thread.
    // Note: Under wasm64 only the low 32-bit of the pthread_ptr are
    // read/compared here, but we don't actually care about the exact values
    // here as long as they match.
    var wait = Atomics.waitAsync((growMemViews(), HEAP32), ((pthread_ptr) >>> 2), pthread_ptr);
    wait.value.then(checkMailbox);
    var waitingAsync = pthread_ptr + 112;
    Atomics.store((growMemViews(), HEAP32), ((waitingAsync) >>> 2), 1);
  }
}

var checkMailbox = () => {
  // checkMailbox can be called after the pthread has shut down. See
  // Pthread.terminateRuntime().
  // In this case we return silently without re-registering using waitAsync.
  // Perhaps there is a more universal way we can detect runtime has exited.
  // TODO(https://github.com/emscripten-core/emscripten/issues/25076)
  var pthread_ptr = _pthread_self();
  if (!pthread_ptr) return;
  callUserCallback(() => {
    // If we are using Atomics.waitAsync as our notification mechanism, wait
    // for a notification before processing the mailbox to avoid missing any
    // work that could otherwise arrive after we've finished processing the
    // mailbox and before we're ready for the next notification.
    __emscripten_thread_mailbox_await(pthread_ptr);
    __emscripten_check_mailbox();
  });
};

var cleanupThread = pthread_ptr => {
  var worker = PThread.pthreads[pthread_ptr];
  PThread.returnWorkerToPool(worker);
};

var spawnThread = threadParams => {
  var worker = PThread.getNewWorker();
  if (!worker) {
    // No available workers in the PThread pool.
    return 6;
  }
  // Add to pthreads map
  PThread.pthreads[threadParams.pthread_ptr] = worker;
  worker.pthread_ptr = threadParams.pthread_ptr;
  var msg = {
    cmd: CMD_RUN,
    start_routine: threadParams.startRoutine,
    arg: threadParams.arg,
    pthread_ptr: threadParams.pthread_ptr
  };
  // Ask the worker to start executing its pthread entry point function.
  worker.postMessage(msg, threadParams.transferList);
  return 0;
};

var terminateWorker = worker => {
  worker.terminate();
  // terminate() can be asynchronous, so in theory the worker can continue
  // to run for some amount of time after termination.  However from our POV
  // the worker is now dead and we don't want to hear from it again, so we stub
  // out its message handler here.  This avoids having to check in each of
  // the onmessage handlers if the message was coming from a valid worker.
  worker.onmessage = e => {};
};

var wasmMemory;

var PThread = {
  unusedWorkers: [],
  tlsInitFunctions: [],
  pthreads: {},
  init() {
    if ((!(ENVIRONMENT_IS_PTHREAD))) {
      PThread.initMainThread();
    }
  },
  initMainThread() {
    var pthreadPoolSize = Math.min(4, (globalThis.navigator && navigator.hardwareConcurrency) || 4);
    // Start loading up the Worker pool, if requested.
    while (pthreadPoolSize--) {
      PThread.allocateUnusedWorker();
    }
    // MINIMAL_RUNTIME takes care of calling loadWasmModuleToAllWorkers
    // in postamble_minimal.js
    addOnPreRun(async () => {
      var pthreadPoolReady = PThread.loadWasmModuleToAllWorkers();
      addRunDependency("loading-workers");
      await pthreadPoolReady;
      removeRunDependency("loading-workers");
    });
  },
  terminateAllThreads: () => {
    // Attempt to kill all workers.  Sadly (at least on the web) there is no
    // way to terminate a worker synchronously, or to be notified when a
    // worker is actually terminated.  This means there is some risk that
    // pthreads will continue to be executing after `worker.terminate` has
    // returned.  For this reason, we don't call `returnWorkerToPool` here or
    // free the underlying pthread data structures.
    for (var worker of Object.values(PThread.pthreads)) {
      terminateWorker(worker);
    }
    for (var worker of PThread.unusedWorkers) {
      terminateWorker(worker);
    }
    PThread.unusedWorkers = [];
    PThread.pthreads = {};
  },
  clearMailboxAwait: pthread_ptr => {
    if (!waitAsyncPolyfilled) {
      Atomics.notify((growMemViews(), HEAP32), ((pthread_ptr) >>> 2));
    }
  },
  terminateRuntime: () => {
    PThread.terminateAllThreads();
    var pthread_ptr = _pthread_self();
    ___set_thread_state(0, 0, 0, 1);
    PThread.clearMailboxAwait(pthread_ptr);
  },
  returnWorkerToPool: worker => {
    // We don't want to run main thread queued calls here, since we are doing
    // some operations that leave the worker queue in an invalid state until
    // we are completely done (it would be bad if free() ends up calling a
    // queued pthread_create which looks at the global data structures we are
    // modifying). To achieve that, defer the free() until the very end, when
    // we are all done.
    var pthread_ptr = worker.pthread_ptr;
    delete PThread.pthreads[pthread_ptr];
    // Note: worker is intentionally not terminated so the pool can
    // dynamically grow.
    PThread.unusedWorkers.push(worker);
    // Not a running Worker anymore
    // Detach the worker from the pthread object, and return it to the
    // worker pool as an unused worker.
    worker.pthread_ptr = 0;
    // Clear any pending waitAsync waiter armed on this thread's struct
    // BEFORE freeing the memory so that memory recycled by malloc in another
    // thread will not have a window where a stale async waiter is still active.
    PThread.clearMailboxAwait(pthread_ptr);
    // Finally, free the underlying (and now-unused) pthread structure in
    // linear memory.
    __emscripten_thread_free_data(pthread_ptr);
  },
  threadInitTLS() {
    // Call thread init functions (these are the _emscripten_tls_init for each
    // module loaded.
    PThread.tlsInitFunctions.forEach(f => f());
  },
  loadWasmModuleToWorker: worker => new Promise(onFinishedLoading => {
    worker.onmessage = e => {
      var d = e.data;
      var cmd = d.cmd;
      // If this message is intended to a recipient that is not the main
      // thread, forward it to the target thread. This is currently only
      // used by `CMD_CHECK_MAILBOX`.
      if (d.targetThread && d.targetThread != _pthread_self()) {
        var targetWorker = PThread.pthreads[d.targetThread];
        targetWorker?.postMessage(d);
        return;
      }
      if (d === "setimmediate" || d === "_si") {
        // Worker wants to postMessage() to itself to implement setImmediate()
        // emulation.
        worker.postMessage(d);
        return;
      }
      switch (cmd) {
       case CMD_CHECK_MAILBOX:
        checkMailbox();
        break;

       case CMD_SPAWN_THREAD:
        spawnThread(d);
        break;

       case CMD_CLEANUP_THREAD:
        // cleanupThread needs to be run via callUserCallback since it calls
        // back into user code to free thread data. Without this it's possible
        // the unwind or ExitStatus exception could escape here.
        callUserCallback(() => cleanupThread(d.thread));
        break;

       case CMD_LOADED:
        if (ENVIRONMENT_IS_NODE && !worker.strongref) {
          // Once worker is loaded & idle, mark it as weakly referenced,
          // so that mere existence of a Worker in the pool does not prevent
          // Node.js from exiting the app.
          worker.unref();
        }
        onFinishedLoading(worker);
        break;

       case CMD_UNCAUGHT_EXN:
        // Message handler for Node.js specific out-of-order behavior:
        // https://github.com/nodejs/node/issues/59617
        // A pthread sent an uncaught exception event. Re-raise it on the main thread.
        worker.onerror(d.error);
        break;

       case CMD_CALL_HANDLER:
        Module[d.handler](...d.args);
        break;

       default:
        // The received message looks like something that should be handled by this message
        // handler, (since there is a e.data.cmd field present), but is not one of the
        // recognized commands:
        if (cmd) err(`worker sent an unknown command ${cmd}`);
      }
    };
    worker.onerror = e => {
      var message = "worker sent an error!";
      err(`${message} ${e.filename}:${e.lineno}: ${e.message}`);
      throw e;
    };
    if (ENVIRONMENT_IS_NODE) {
      worker.on("message", data => worker.onmessage({
        data
      }));
      worker.on("error", e => worker.onerror(e));
    }
    // When running on a pthread, none of the incoming parameters on the module
    // object are present. Proxy known handlers back to the main thread if specified.
    var handlers = [];
    var knownHandlers = [ "onExit", "onAbort", "print", "printErr" ];
    for (var handler of knownHandlers) {
      if (Module.propertyIsEnumerable(handler)) {
        handlers.push(handler);
      }
    }
    // Ask the new worker to load up the Emscripten-compiled page. This is a heavy operation.
    worker.postMessage({
      cmd: CMD_LOAD,
      handlers,
      wasmMemory,
      wasmModule
    });
  }),
  async loadWasmModuleToAllWorkers() {
    // Instantiation is synchronous in pthreads.
    if (ENVIRONMENT_IS_PTHREAD) {
      return;
    }
    let pthreadPoolReady = Promise.all(PThread.unusedWorkers.map(PThread.loadWasmModuleToWorker));
    return pthreadPoolReady;
  },
  allocateUnusedWorker() {
    var worker;
    var pthreadMainJs = _scriptName;
    worker = new Worker(pthreadMainJs, {
      // This is the way that we signal to the node worker that it is hosting
      // a pthread.
      "workerData": "em-pthread",
      // This is the way that we signal to the Web Worker that it is hosting
      // a pthread.
      "name": "em-pthread"
    });
    PThread.unusedWorkers.push(worker);
    return worker;
  },
  getNewWorker() {
    if (PThread.unusedWorkers.length == 0) {
      // PTHREAD_POOL_SIZE_STRICT should show a warning and, if set to level `2`, return from the function.
      var newWorker = PThread.allocateUnusedWorker();
      PThread.loadWasmModuleToWorker(newWorker);
    }
    return PThread.unusedWorkers.pop();
  }
};

var onPostRuns = [];

var addOnPostRun = cb => onPostRuns.push(cb);

/** @type {!Uint32Array} */ var HEAPU32;

function establishStackSpace(pthread_ptr) {
  var stackHigh = (growMemViews(), HEAPU32)[(((pthread_ptr) + (48)) >>> 2) >>> 0];
  var stackSize = (growMemViews(), HEAPU32)[(((pthread_ptr) + (52)) >>> 2) >>> 0];
  var stackLow = stackHigh - stackSize;
  // Set stack limits used by `emscripten/stack.h` function.  These limits are
  // cached in wasm-side globals to make checks as fast as possible.
  _emscripten_stack_set_limits(stackHigh, stackLow);
  // Call inside wasm module to set up the stack frame for this pthread in wasm module scope
  stackRestore(stackHigh);
}

var runtimeKeepalivePop = () => {
  runtimeKeepaliveCounter -= 1;
};

var runtimeKeepalivePush = () => {
  runtimeKeepaliveCounter += 1;
};

var Asyncify = {
  instrumentWasmImports(imports) {
    var importPattern = /^(invoke_.*|__asyncjs__.*)$/;
    for (let [x, original] of Object.entries(imports)) {
      if (typeof original === "function") {
        let isAsyncifyImport = original.isAsync || importPattern.test(x);
        // Wrap async imports with a suspending WebAssembly function.
        if (isAsyncifyImport) {
          imports[x] = original = new WebAssembly.Suspending(original);
        }
      }
    }
  },
  instrumentWasmExports(exports) {
    var exportPattern = /^(uew_ctx_start|main|__main_argc_argv)$/;
    Asyncify.asyncExports = new Set;
    var ret = {};
    for (let [x, original] of Object.entries(exports)) {
      if (typeof original === "function") {
        // Wrap all exports with a promising WebAssembly function.
        let isAsyncifyExport = exportPattern.test(x);
        if (isAsyncifyExport) {
          Asyncify.asyncExports.add(original);
          original = Asyncify.makeAsyncFunction(original);
        }
        ret[x] = original;
      } else {
        ret[x] = original;
      }
    }
    return ret;
  },
  asyncExports: null,
  isAsyncExport(func) {
    return Asyncify.asyncExports?.has(func);
  },
  handleAsync: async startAsync => {
    runtimeKeepalivePush();
    try {
      return await startAsync();
    } finally {
      runtimeKeepalivePop();
    }
  },
  handleSleep: startAsync => Asyncify.handleAsync(() => new Promise(startAsync)),
  makeAsyncFunction(original) {
    return WebAssembly.promising(original);
  }
};

var wasmTableMirror = [];

var getWasmTableEntry = funcPtr => {
  var func = wasmTableMirror[funcPtr];
  if (!func) {
    /** @suppress {checkTypes} */ wasmTableMirror[funcPtr] = func = wasmTable.get(funcPtr);
    if (Asyncify.isAsyncExport(func)) {
      wasmTableMirror[funcPtr] = func = Asyncify.makeAsyncFunction(func);
    }
  }
  return func;
};

var invokeEntryPoint = async (ptr, arg) => {
  // An old thread on this worker may have been canceled without returning the
  // `runtimeKeepaliveCounter` to zero. Reset it now so the new thread won't
  // be affected.
  runtimeKeepaliveCounter = 0;
  // Same for noExitRuntime.  The default for pthreads should always be false
  // otherwise pthreads would never complete and attempts to pthread_join to
  // them would block forever.
  // pthreads can still choose to set `noExitRuntime` explicitly, or
  // call emscripten_unwind_to_js_event_loop to extend their lifetime beyond
  // their main function.  See comment in src/runtime_pthread.js for more.
  noExitRuntime = 0;
  // pthread entry points are always of signature 'void *ThreadMain(void *arg)'
  // Native codebases sometimes spawn threads with other thread entry point
  // signatures, such as void ThreadMain(void *arg), void *ThreadMain(), or
  // void ThreadMain().  That is not acceptable per C/C++ specification, but
  // x86 compiler ABI extensions enable that to work. If you find the
  // following line to crash, either change the signature to "proper" void
  // *ThreadMain(void *arg) form, or try linking with the Emscripten linker
  // flag -sEMULATE_FUNCTION_POINTER_CASTS to add in emulation for this x86
  // ABI extension.
  var result = WebAssembly.promising(getWasmTableEntry(ptr))(arg);
  function finish(result) {
    // In MINIMAL_RUNTIME the noExitRuntime concept does not apply to
    // pthreads. To exit a pthread with live runtime, use the function
    // emscripten_unwind_to_js_event_loop() in the pthread body.
    if (keepRuntimeAlive()) {
      EXITSTATUS = result;
      return;
    }
    __emscripten_thread_exit(result);
  }
  result = await result;
  finish(result);
};

var noExitRuntime = false;

var registerTLSInit = tlsInitFunc => PThread.tlsInitFunctions.push(tlsInitFunc);

function pthreadCreateProxied(pthread_ptr, attr, startRoutine, arg) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(2, 0, 1, pthread_ptr, attr, startRoutine, arg);
  return ___pthread_create_js(pthread_ptr, attr, startRoutine, arg);
}

var _emscripten_has_threading_support = () => !!globalThis.SharedArrayBuffer;

function ___pthread_create_js(pthread_ptr, attr, startRoutine, arg) {
  pthread_ptr >>>= 0;
  attr >>>= 0;
  startRoutine >>>= 0;
  arg >>>= 0;
  if (!_emscripten_has_threading_support()) {
    return 6;
  }
  // List of JS objects that will transfer ownership to the Worker hosting the thread
  var transferList = [];
  var error = 0;
  // Synchronously proxy the thread creation to main thread if possible. If we
  // need to transfer ownership of objects, then proxy asynchronously via
  // postMessage.
  if (ENVIRONMENT_IS_PTHREAD && (!transferList.length || error)) {
    return pthreadCreateProxied(pthread_ptr, attr, startRoutine, arg);
  }
  // If on the main thread, and accessing Canvas/OffscreenCanvas failed, abort
  // with the detected error.
  if (error) return error;
  var threadParams = {
    startRoutine,
    pthread_ptr,
    arg,
    transferList
  };
  if (ENVIRONMENT_IS_PTHREAD) {
    // The prepopulated pool of web workers that can host pthreads is stored
    // in the main JS thread. Therefore if a pthread is attempting to spawn a
    // new thread, the thread creation must be deferred to the main JS thread.
    threadParams.cmd = CMD_SPAWN_THREAD;
    postMessage(threadParams, transferList);
    // When we defer thread creation this way, we have no way to detect thread
    // creation synchronously today, so we have to assume success and return 0.
    return 0;
  }
  // We are the main thread, so we have the pthread warmup pool in this
  // thread and can fire off JS thread creation directly ourselves.
  return spawnThread(threadParams);
}

const FS_MAX_OPEN_FDS = 4096;

var FS_createDataFile = (...args) => FS.createDataFile(...args);

var preloadPlugins = [];

var FS_handledByPreloadPlugin = async (byteArray, fullname) => {
  // Ensure plugins are ready.
  if (typeof Browser !== "undefined") Browser.init();
  for (var plugin of preloadPlugins) {
    if (plugin["canHandle"](fullname)) {
      return plugin["handle"](byteArray, fullname);
    }
  }
  // If no plugin handled this file then return the original/unmodified
  // byteArray.
  return byteArray;
};

var PATH = {
  isAbs: path => path.charAt(0) === "/",
  splitPath: filename => {
    var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
    return splitPathRe.exec(filename).slice(1);
  },
  normalizeArray: (parts, allowAboveRoot) => {
    // if the path tries to go above the root, `up` ends up > 0
    var up = 0;
    for (var i = parts.length - 1; i >= 0; i--) {
      var last = parts[i];
      if (last === ".") {
        parts.splice(i, 1);
      } else if (last === "..") {
        parts.splice(i, 1);
        up++;
      } else if (up) {
        parts.splice(i, 1);
        up--;
      }
    }
    // if the path is allowed to go above the root, restore leading ..s
    if (allowAboveRoot) {
      for (;up; up--) {
        parts.unshift("..");
      }
    }
    return parts;
  },
  normalize: path => {
    var isAbsolute = PATH.isAbs(path), trailingSlash = path.slice(-1) === "/";
    // Normalize the path
    path = PATH.normalizeArray(path.split("/").filter(p => !!p), !isAbsolute).join("/");
    if (!path && !isAbsolute) {
      path = ".";
    }
    if (path && trailingSlash) {
      path += "/";
    }
    return (isAbsolute ? "/" : "") + path;
  },
  dirname: path => {
    var result = PATH.splitPath(path), root = result[0], dir = result[1];
    if (!root && !dir) {
      // No dirname whatsoever
      return ".";
    }
    if (dir) {
      // It has a dirname, strip trailing slash
      dir = dir.slice(0, -1);
    }
    return root + dir;
  },
  basename: path => path && path.match(/([^\/]+|\/)\/*$/)[1],
  join: (...paths) => PATH.normalize(paths.join("/")),
  join2: (l, r) => PATH.normalize(l + "/" + r)
};

var PATH_FS = {
  resolve: (...args) => {
    var resolvedPath = "", resolvedAbsolute = false;
    for (var i = args.length - 1; i >= -1 && !resolvedAbsolute; i--) {
      var path = (i >= 0) ? args[i] : FS.cwd();
      // Skip empty and invalid entries
      if (typeof path !== "string") {
        throw new TypeError("Arguments to path.resolve must be strings");
      } else if (!path) {
        return "";
      }
      resolvedPath = path + "/" + resolvedPath;
      resolvedAbsolute = PATH.isAbs(path);
    }
    // At this point the path should be resolved to a full absolute path, but
    // handle relative paths to be safe (might happen when process.cwd() fails)
    resolvedPath = PATH.normalizeArray(resolvedPath.split("/").filter(p => !!p), !resolvedAbsolute).join("/");
    return ((resolvedAbsolute ? "/" : "") + resolvedPath) || ".";
  },
  relative: (from, to) => {
    from = PATH_FS.resolve(from).slice(1);
    to = PATH_FS.resolve(to).slice(1);
    function trim(arr) {
      var start = 0;
      for (;start < arr.length; start++) {
        if (arr[start] !== "") break;
      }
      var end = arr.length - 1;
      for (;end >= 0; end--) {
        if (arr[end] !== "") break;
      }
      if (start > end) return [];
      return arr.slice(start, end - start + 1);
    }
    var fromParts = trim(from.split("/"));
    var toParts = trim(to.split("/"));
    var length = Math.min(fromParts.length, toParts.length);
    var samePartsLength = length;
    for (var i = 0; i < length; i++) {
      if (fromParts[i] !== toParts[i]) {
        samePartsLength = i;
        break;
      }
    }
    var outputParts = [];
    for (var i = samePartsLength; i < fromParts.length; i++) {
      outputParts.push("..");
    }
    outputParts = outputParts.concat(toParts.slice(samePartsLength));
    return outputParts.join("/");
  }
};

var asyncLoad = async url => {
  var arrayBuffer = await readAsync(url);
  return new Uint8Array(arrayBuffer);
};

var getUniqueRunDependency = id => id;

var FS_preloadFile = async (parent, name, url, canRead = undefined, canWrite = undefined, dontCreateFile = undefined, canOwn = undefined, preFinish = undefined) => {
  // TODO we should allow people to just pass in a complete filename instead
  // of parent and name being that we just join them anyways
  var fullname = name ? PATH_FS.resolve(PATH.join2(parent, name)) : parent;
  var dep = getUniqueRunDependency(`cp ${fullname}`);
  // might have several active requests for the same fullname
  addRunDependency(dep);
  try {
    var byteArray = url;
    if (typeof url === "string") {
      byteArray = await asyncLoad(url);
    }
    byteArray = await FS_handledByPreloadPlugin(byteArray, fullname);
    preFinish?.();
    if (!dontCreateFile) {
      FS_createDataFile(parent, name, byteArray, canRead, canWrite, canOwn);
    }
  } finally {
    removeRunDependency(dep);
  }
};

var FS_createPreloadedFile = (parent, name, url, canRead = undefined, canWrite = undefined, onload = undefined, onerror = undefined, dontCreateFile = undefined, canOwn = undefined, preFinish = undefined) => {
  FS_preloadFile(parent, name, url, canRead, canWrite, dontCreateFile, canOwn, preFinish).then(onload).catch(onerror);
};

var lengthBytesUTF8 = str => {
  var len = 0;
  for (var i = 0; i < str.length; ++i) {
    var u = str.codePointAt(i);
    if (u <= 127) {
      len++;
    } else if (u <= 2047) {
      len += 2;
    } else if (u <= 65535) {
      len += 3;
    } else {
      len += 4;
      // Gotcha: if codePoint is over 0xFFFF, it is represented as a surrogate pair in UTF-16.
      // We need to manually skip over the second code unit for correct iteration.
      i++;
    }
  }
  return len;
};

var stringToUTF8Array = (str, heap, outIdx, maxBytesToWrite) => {
  outIdx >>>= 0;
  // Parameter maxBytesToWrite is not optional. Negative values, 0, null,
  // undefined and false each don't write out any bytes.
  if (!(maxBytesToWrite > 0)) return 0;
  var startIdx = outIdx;
  var endIdx = outIdx + maxBytesToWrite - 1;
  // -1 for string null terminator.
  for (var i = 0; i < str.length; ++i) {
    // For UTF8 byte structure, see http://en.wikipedia.org/wiki/UTF-8#Description
    // and https://www.ietf.org/rfc/rfc2279.txt
    // and https://tools.ietf.org/html/rfc3629
    var u = str.codePointAt(i);
    if (u <= 127) {
      if (outIdx >= endIdx) break;
      heap[outIdx++ >>> 0] = u;
    } else if (u <= 2047) {
      if (outIdx + 1 >= endIdx) break;
      heap[outIdx++ >>> 0] = 192 | (u >> 6);
      heap[outIdx++ >>> 0] = 128 | (u & 63);
    } else if (u <= 65535) {
      if (outIdx + 2 >= endIdx) break;
      heap[outIdx++ >>> 0] = 224 | (u >> 12);
      heap[outIdx++ >>> 0] = 128 | ((u >> 6) & 63);
      heap[outIdx++ >>> 0] = 128 | (u & 63);
    } else {
      if (outIdx + 3 >= endIdx) break;
      heap[outIdx++ >>> 0] = 240 | (u >> 18);
      heap[outIdx++ >>> 0] = 128 | ((u >> 12) & 63);
      heap[outIdx++ >>> 0] = 128 | ((u >> 6) & 63);
      heap[outIdx++ >>> 0] = 128 | (u & 63);
      // Gotcha: if codePoint is over 0xFFFF, it is represented as a surrogate pair in UTF-16.
      // We need to manually skip over the second code unit for correct iteration.
      i++;
    }
  }
  // Null-terminate the pointer to the buffer.
  heap[outIdx >>> 0] = 0;
  return outIdx - startIdx;
};

/** @type {function(string, boolean=, number=)} */ var intArrayFromString = (stringy, dontAddNull, length) => {
  var len = length > 0 ? length : lengthBytesUTF8(stringy) + 1;
  var u8array = new Array(len);
  var numBytesWritten = stringToUTF8Array(stringy, u8array, 0, u8array.length);
  if (dontAddNull) u8array.length = numBytesWritten;
  return u8array;
};

var FS_fileDataToTypedArray = data => {
  if (typeof data === "string") {
    data = intArrayFromString(data, true);
  }
  if (!data.subarray) {
    data = new Uint8Array(data);
  }
  return data;
};

var FS_getMode = (canRead, canWrite) => {
  var mode = 0;
  if (canRead) mode |= 292 | 73;
  if (canWrite) mode |= 146;
  return mode;
};

var FS_modeStringToFlags = str => {
  if (typeof str !== "string") return str;
  var flagModes = {
    "r": 0,
    "r+": 2,
    "w": 512 | 64 | 1,
    "w+": 512 | 64 | 2,
    "a": 1024 | 64 | 1,
    "a+": 1024 | 64 | 2
  };
  var flags = flagModes[str];
  if (typeof flags === "undefined") {
    throw new Error(`Unknown file open mode: ${str}`);
  }
  return flags;
};

const IDBFS_DB_STORE_NAME = "FILE_DATA";

const IDBFS_DB_VERSION = 21;

var mmapAlloc = size => {
  abort();
};

var MEMFS = {
  ops_table: null,
  mount(mount) {
    return MEMFS.createNode(null, "/", 16895, 0);
  },
  createNode(parent, name, mode, dev = undefined) {
    if (FS.isBlkdev(mode) || FS.isFIFO(mode)) {
      // not supported
      throw new FS.ErrnoError(63);
    }
    MEMFS.ops_table ||= {
      dir: {
        node: {
          getattr: MEMFS.node_ops.getattr,
          setattr: MEMFS.node_ops.setattr,
          lookup: MEMFS.node_ops.lookup,
          mknod: MEMFS.node_ops.mknod,
          rename: MEMFS.node_ops.rename,
          unlink: MEMFS.node_ops.unlink,
          rmdir: MEMFS.node_ops.rmdir,
          readdir: MEMFS.node_ops.readdir,
          symlink: MEMFS.node_ops.symlink
        },
        stream: {
          llseek: MEMFS.stream_ops.llseek
        }
      },
      file: {
        node: {
          getattr: MEMFS.node_ops.getattr,
          setattr: MEMFS.node_ops.setattr
        },
        stream: {
          llseek: MEMFS.stream_ops.llseek,
          read: MEMFS.stream_ops.read,
          write: MEMFS.stream_ops.write,
          mmap: MEMFS.stream_ops.mmap,
          msync: MEMFS.stream_ops.msync
        }
      },
      link: {
        node: {
          getattr: MEMFS.node_ops.getattr,
          setattr: MEMFS.node_ops.setattr,
          readlink: MEMFS.node_ops.readlink
        },
        stream: {}
      },
      chrdev: {
        node: {
          getattr: MEMFS.node_ops.getattr,
          setattr: MEMFS.node_ops.setattr
        },
        stream: FS.chrdev_stream_ops
      }
    };
    var node = FS.createNode(parent, name, mode, dev);
    if (FS.isDir(node.mode)) {
      node.node_ops = MEMFS.ops_table.dir.node;
      node.stream_ops = MEMFS.ops_table.dir.stream;
      node.contents = {};
    } else if (FS.isFile(node.mode)) {
      node.node_ops = MEMFS.ops_table.file.node;
      node.stream_ops = MEMFS.ops_table.file.stream;
      // The actual number of bytes used in the typed array, as opposed to
      // contents.length which gives the whole capacity.
      node.usedBytes = 0;
      // The byte data of the file is stored in a typed array.
      // Note: typed arrays are not resizable like normal JS arrays are, so
      // there is a small penalty involved for appending file writes that
      // continuously grow a file similar to std::vector capacity vs used.
      node.contents = MEMFS.emptyFileContents ??= new Uint8Array(0);
    } else if (FS.isLink(node.mode)) {
      node.node_ops = MEMFS.ops_table.link.node;
      node.stream_ops = MEMFS.ops_table.link.stream;
    } else if (FS.isChrdev(node.mode)) {
      node.node_ops = MEMFS.ops_table.chrdev.node;
      node.stream_ops = MEMFS.ops_table.chrdev.stream;
    }
    node.atime = node.mtime = node.ctime = Date.now();
    // add the new node to the parent
    if (parent) {
      parent.contents[name] = node;
      parent.atime = parent.mtime = parent.ctime = node.atime;
    }
    return node;
  },
  getFileDataAsTypedArray(node) {
    return node.contents.subarray(0, node.usedBytes);
  },
  expandFileStorage(node, newCapacity) {
    var prevCapacity = node.contents.length;
    if (prevCapacity >= newCapacity) return;
    // No need to expand, the storage was already large enough.
    // Don't expand strictly to the given requested limit if it's only a very
    // small increase, but instead geometrically grow capacity.
    // For small filesizes (<1MB), perform size*2 geometric increase, but for
    // large sizes, do a much more conservative size*1.125 increase to avoid
    // overshooting the allocation cap by a very large margin.
    const CAPACITY_DOUBLING_MAX = 1024 * 1024;
    newCapacity = Math.max(newCapacity, (prevCapacity * (prevCapacity < CAPACITY_DOUBLING_MAX ? 2 : 1.125)) >>> 0);
    if (prevCapacity) newCapacity = Math.max(newCapacity, 256);
    // At minimum allocate 256b for each file when expanding.
    var oldContents = MEMFS.getFileDataAsTypedArray(node);
    node.contents = new Uint8Array(newCapacity);
    // Allocate new storage.
    node.contents.set(oldContents);
  },
  resizeFileStorage(node, newSize) {
    if (node.usedBytes == newSize) return;
    var oldContents = node.contents;
    node.contents = new Uint8Array(newSize);
    // Allocate new storage.
    node.contents.set(oldContents.subarray(0, Math.min(newSize, node.usedBytes)));
    // Copy old data over to the new storage.
    node.usedBytes = newSize;
  },
  node_ops: {
    getattr(node) {
      var attr = {};
      // device numbers reuse inode numbers.
      attr.dev = FS.isChrdev(node.mode) ? node.id : 1;
      attr.ino = node.id;
      attr.mode = node.mode;
      attr.nlink = 1;
      attr.uid = 0;
      attr.gid = 0;
      attr.rdev = node.rdev;
      if (FS.isDir(node.mode)) {
        attr.size = 4096;
      } else if (FS.isFile(node.mode)) {
        attr.size = node.usedBytes;
      } else if (FS.isLink(node.mode)) {
        attr.size = node.link.length;
      } else {
        attr.size = 0;
      }
      attr.atime = new Date(node.atime);
      attr.mtime = new Date(node.mtime);
      attr.ctime = new Date(node.ctime);
      // NOTE: In our implementation, st_blocks = Math.ceil(st_size/st_blksize),
      //       but this is not required by the standard.
      attr.blksize = 4096;
      attr.blocks = Math.ceil(attr.size / attr.blksize);
      return attr;
    },
    setattr(node, attr) {
      for (const key of [ "mode", "atime", "mtime", "ctime" ]) {
        if (attr[key] != null) {
          node[key] = attr[key];
        }
      }
      if (attr.size !== undefined) {
        MEMFS.resizeFileStorage(node, attr.size);
      }
    },
    lookup(parent, name) {
      // This error may happen quite a bit. To avoid overhead we reuse it (and
      // suffer a lack of stack info).
      if (!MEMFS.doesNotExistError) {
        MEMFS.doesNotExistError = new FS.ErrnoError(44);
        /** @suppress {checkTypes} */ MEMFS.doesNotExistError.stack = "<generic error, no stack>";
      }
      throw MEMFS.doesNotExistError;
    },
    mknod(parent, name, mode, dev = undefined) {
      return MEMFS.createNode(parent, name, mode, dev);
    },
    rename(old_node, new_dir, new_name) {
      var new_node;
      try {
        new_node = FS.lookupNode(new_dir, new_name);
      } catch (e) {}
      if (new_node && FS.isDir(old_node.mode)) {
        // if we're overwriting a directory at new_name, make sure it's empty.
        for (var i in new_node.contents) {
          throw new FS.ErrnoError(55);
        }
      }
      // do the internal rewiring
      delete old_node.parent.contents[old_node.name];
      new_dir.contents[new_name] = old_node;
      old_node.name = new_name;
      new_dir.ctime = new_dir.mtime = old_node.parent.ctime = old_node.parent.mtime = Date.now();
    },
    unlink(parent, name) {
      delete parent.contents[name];
      parent.ctime = parent.mtime = Date.now();
    },
    rmdir(parent, name) {
      var node = FS.lookupNode(parent, name);
      for (var i in node.contents) {
        throw new FS.ErrnoError(55);
      }
      delete parent.contents[name];
      parent.ctime = parent.mtime = Date.now();
    },
    readdir(node) {
      return [ ".", "..", ...Object.keys(node.contents) ];
    },
    symlink(parent, newname, oldpath) {
      var node = MEMFS.createNode(parent, newname, 511 | 40960, 0);
      node.link = oldpath;
      return node;
    },
    readlink(node) {
      if (!FS.isLink(node.mode)) {
        throw new FS.ErrnoError(28);
      }
      return node.link;
    }
  },
  stream_ops: {
    read(stream, buffer, offset, length, position) {
      var contents = stream.node.contents;
      if (position >= stream.node.usedBytes) return 0;
      var size = Math.min(stream.node.usedBytes - position, length);
      buffer.set(contents.subarray(position, position + size), offset);
      return size;
    },
    write(stream, buffer, offset, length, position, canOwn) {
      // If the buffer is located in main memory (HEAP), and if
      // memory can grow, we can't hold on to references of the
      // memory buffer, as they may get invalidated. That means we
      // need to copy its contents.
      if (buffer.buffer === (growMemViews(), HEAP8).buffer) {
        canOwn = false;
      }
      if (!length) return 0;
      var node = stream.node;
      node.mtime = node.ctime = Date.now();
      if (canOwn) {
        node.contents = buffer.subarray(offset, offset + length);
        node.usedBytes = length;
      } else if (!node.usedBytes && !position) {
        // If this is a simple first write to an empty file, do a fast set since we don't need to care about old data.
        node.contents = buffer.slice(offset, offset + length);
        node.usedBytes = length;
      } else {
        MEMFS.expandFileStorage(node, position + length);
        // Use typed array write which is available.
        node.contents.set(buffer.subarray(offset, offset + length), position);
        node.usedBytes = Math.max(node.usedBytes, position + length);
      }
      return length;
    },
    llseek(stream, offset, whence) {
      var position = offset;
      if (whence === 1) {
        position += stream.position;
      } else if (whence === 2) {
        if (FS.isFile(stream.node.mode)) {
          position += stream.node.usedBytes;
        }
      }
      if (position < 0) {
        throw new FS.ErrnoError(28);
      }
      return position;
    },
    mmap(stream, length, position, prot, flags) {
      if (!FS.isFile(stream.node.mode)) {
        throw new FS.ErrnoError(43);
      }
      var ptr;
      var allocated;
      var contents = stream.node.contents;
      // Only make a new copy when MAP_PRIVATE is specified.
      if (!(flags & 2) && contents.buffer === (growMemViews(), HEAP8).buffer) {
        // We can't emulate MAP_SHARED when the file is not backed by the
        // buffer we're mapping to (e.g. the HEAP buffer).
        allocated = false;
        ptr = contents.byteOffset;
      } else {
        allocated = true;
        ptr = mmapAlloc(length);
        if (!ptr) {
          throw new FS.ErrnoError(48);
        }
        if (contents) {
          // Try to avoid unnecessary slices.
          if (position > 0 || position + length < contents.length) {
            if (contents.subarray) {
              contents = contents.subarray(position, position + length);
            } else {
              contents = contents.slice(position, position + length);
            }
          }
          (growMemViews(), HEAP8).set(contents, ptr >>> 0);
        }
      }
      return {
        ptr,
        allocated
      };
    },
    msync(stream, buffer, offset, length, mmapFlags) {
      MEMFS.stream_ops.write(stream, buffer, 0, length, offset, false);
      // should we check if bytesWritten and length are the same?
      return 0;
    }
  }
};

var IDBFS = {
  dbs: {},
  indexedDB: () => indexedDB,
  queuePersist: mount => {
    function onPersistComplete() {
      if (mount.idbPersistState === "again") startPersist(); else {
        mount.idbPersistState = 0;
        // Otherwise reset sync state back to idle to wait for a new sync later
        IDBFS.onAutoPersistStateChanged?.(false);
      }
    }
    function startPersist() {
      mount.idbPersistState = "idb";
      // Mark that we are currently running a sync operation
      IDBFS.onAutoPersistStateChanged?.(true);
      IDBFS.syncfs(mount, /*populate:*/ false, onPersistComplete);
    }
    if (!mount.idbPersistState) {
      // Programs typically write/copy/move multiple files in the in-memory
      // filesystem within a single app frame, so when a filesystem sync
      // command is triggered, do not start it immediately, but only after
      // the current frame is finished. This way all the modified files
      // inside the main loop tick will be batched up to the same sync.
      mount.idbPersistState = setTimeout(startPersist, 0);
    } else if (mount.idbPersistState === "idb") {
      // There is an active IndexedDB sync operation in-flight, but we now
      // have accumulated more files to sync. We should therefore queue up
      // a new sync after the current one finishes so that all writes
      // will be properly persisted.
      mount.idbPersistState = "again";
    }
  },
  mount: mount => {
    // reuse core MEMFS functionality
    var mnt = MEMFS.mount(mount);
    // If the automatic IDBFS persistence option has been selected, then automatically persist
    // all modifications to the filesystem as they occur.
    if (mount?.opts?.autoPersist) {
      mount.idbPersistState = 0;
      // IndexedDB sync starts in idle state
      var memfs_node_ops = mnt.node_ops;
      mnt.node_ops = {
        ...mnt.node_ops
      };
      // Clone node_ops to inject write tracking
      mnt.node_ops.mknod = (parent, name, mode, dev) => {
        var node = memfs_node_ops.mknod(parent, name, mode, dev);
        // Propagate injected node_ops to the newly created child node
        node.node_ops = mnt.node_ops;
        // Remember for each IDBFS node which IDBFS mount point they came from so we know which mount to persist on modification.
        node.idbfs_mount = mnt.mount;
        // Remember original MEMFS stream_ops for this node
        node.memfs_stream_ops = node.stream_ops;
        // Clone stream_ops to inject write tracking
        node.stream_ops = {
          ...node.stream_ops
        };
        // Track all file writes
        node.stream_ops.write = (stream, buffer, offset, length, position, canOwn) => {
          // This file has been modified, we must persist IndexedDB when this file closes
          stream.node.isModified = true;
          return node.memfs_stream_ops.write(stream, buffer, offset, length, position, canOwn);
        };
        // Persist IndexedDB on file close
        node.stream_ops.close = stream => {
          var n = stream.node;
          if (n.isModified) {
            IDBFS.queuePersist(n.idbfs_mount);
            n.isModified = false;
          }
          if (n.memfs_stream_ops.close) return n.memfs_stream_ops.close(stream);
        };
        // Persist the node we just created to IndexedDB
        IDBFS.queuePersist(mnt.mount);
        return node;
      };
      // Also kick off persisting the filesystem on other operations that modify the filesystem.
      mnt.node_ops.rmdir = (...args) => (IDBFS.queuePersist(mnt.mount), memfs_node_ops.rmdir(...args));
      mnt.node_ops.symlink = (...args) => (IDBFS.queuePersist(mnt.mount), memfs_node_ops.symlink(...args));
      mnt.node_ops.unlink = (...args) => (IDBFS.queuePersist(mnt.mount), memfs_node_ops.unlink(...args));
      mnt.node_ops.rename = (...args) => (IDBFS.queuePersist(mnt.mount), memfs_node_ops.rename(...args));
    }
    return mnt;
  },
  syncfs: (mount, populate, callback) => {
    IDBFS.getLocalSet(mount, (err, local) => {
      if (err) return callback(err);
      IDBFS.getRemoteSet(mount, (err, remote) => {
        if (err) return callback(err);
        var src = populate ? remote : local;
        var dst = populate ? local : remote;
        IDBFS.reconcile(src, dst, callback);
      });
    });
  },
  quit: () => {
    for (var value of Object.values(IDBFS.dbs)) {
      value.close();
    }
    IDBFS.dbs = {};
  },
  getDB: (name, callback) => {
    // check the cache first
    var db = IDBFS.dbs[name];
    if (db) {
      return callback(null, db);
    }
    var req;
    try {
      req = IDBFS.indexedDB().open(name, IDBFS_DB_VERSION);
    } catch (e) {
      return callback(e);
    }
    if (!req) {
      return callback("Unable to connect to IndexedDB");
    }
    req.onupgradeneeded = e => {
      var db = /** @type {IDBDatabase} */ (e.target.result);
      var transaction = e.target.transaction;
      var fileStore;
      if (db.objectStoreNames.contains(IDBFS_DB_STORE_NAME)) {
        fileStore = transaction.objectStore(IDBFS_DB_STORE_NAME);
      } else {
        fileStore = db.createObjectStore(IDBFS_DB_STORE_NAME);
      }
      if (!fileStore.indexNames.contains("timestamp")) {
        fileStore.createIndex("timestamp", "timestamp", {
          unique: false
        });
      }
    };
    req.onsuccess = () => {
      db = /** @type {IDBDatabase} */ (req.result);
      // add to the cache
      IDBFS.dbs[name] = db;
      callback(null, db);
    };
    req.onerror = e => {
      callback(e.target.error);
      e.preventDefault();
    };
  },
  getLocalSet: (mount, callback) => {
    var entries = {};
    function isRealDir(p) {
      return p !== "." && p !== "..";
    }
    function toAbsolute(root) {
      return p => PATH.join2(root, p);
    }
    var check = FS.readdir(mount.mountpoint).filter(isRealDir).map(toAbsolute(mount.mountpoint));
    while (check.length) {
      var path = check.pop();
      var stat;
      try {
        stat = FS.lstat(path);
      } catch (e) {
        return callback(e);
      }
      if (FS.isDir(stat.mode)) {
        check.push(...FS.readdir(path).filter(isRealDir).map(toAbsolute(path)));
      }
      entries[path] = {
        "timestamp": stat.mtime
      };
    }
    return callback(null, {
      type: "local",
      entries
    });
  },
  getRemoteSet: (mount, callback) => {
    var entries = {};
    IDBFS.getDB(mount.mountpoint, (err, db) => {
      if (err) return callback(err);
      try {
        var transaction = db.transaction([ IDBFS_DB_STORE_NAME ], "readonly");
        transaction.onerror = e => {
          callback(e.target.error);
          e.preventDefault();
        };
        var store = transaction.objectStore(IDBFS_DB_STORE_NAME);
        var index = store.index("timestamp");
        index.openKeyCursor().onsuccess = event => {
          var cursor = event.target.result;
          if (!cursor) {
            return callback(null, {
              type: "remote",
              db,
              entries
            });
          }
          entries[cursor.primaryKey] = {
            "timestamp": cursor.key
          };
          cursor.continue();
        };
      } catch (e) {
        return callback(e);
      }
    });
  },
  loadLocalEntry: (path, callback) => {
    var stat, node;
    try {
      var lookup = FS.lookupPath(path);
      node = lookup.node;
      stat = FS.lstat(path);
    } catch (e) {
      return callback(e);
    }
    if (FS.isDir(stat.mode)) {
      return callback(null, {
        "timestamp": stat.mtime,
        "mode": stat.mode
      });
    } else if (FS.isLink(stat.mode)) {
      return callback(null, {
        "timestamp": stat.mtime,
        "mode": stat.mode,
        "link": node.link
      });
    } else if (FS.isFile(stat.mode)) {
      // Performance consideration: storing a normal JavaScript array to a IndexedDB is much slower than storing a typed array.
      // Therefore always convert the file contents to a typed array first before writing the data to IndexedDB.
      node.contents = MEMFS.getFileDataAsTypedArray(node);
      return callback(null, {
        "timestamp": stat.mtime,
        "mode": stat.mode,
        "contents": node.contents
      });
    } else {
      return callback(new Error("node type not supported"));
    }
  },
  storeLocalEntry: (path, entry, callback) => {
    try {
      if (FS.isDir(entry["mode"])) {
        FS.mkdirTree(path, entry["mode"]);
      } else if (FS.isLink(entry["mode"])) {
        FS.symlink(entry["link"], path);
      } else if (FS.isFile(entry["mode"])) {
        FS.writeFile(path, entry["contents"], {
          canOwn: true
        });
      } else {
        return callback(new Error("node type not supported"));
      }
      FS.chmod(path, entry["mode"]);
      FS.utime(path, entry["timestamp"], entry["timestamp"]);
    } catch (e) {
      return callback(e);
    }
    callback(null);
  },
  removeLocalEntry: (path, callback) => {
    try {
      var stat = FS.lstat(path);
      if (FS.isDir(stat.mode)) {
        FS.rmdir(path);
      } else {
        FS.unlink(path);
      }
    } catch (e) {
      return callback(e);
    }
    callback(null);
  },
  loadRemoteEntry: (store, path, callback) => {
    var req = store.get(path);
    req.onsuccess = event => callback(null, event.target.result);
    req.onerror = e => {
      callback(e.target.error);
      e.preventDefault();
    };
  },
  storeRemoteEntry: (store, path, entry, callback) => {
    try {
      var req = store.put(entry, path);
    } catch (e) {
      callback(e);
      return;
    }
    req.onsuccess = event => callback();
    req.onerror = e => {
      callback(e.target.error);
      e.preventDefault();
    };
  },
  removeRemoteEntry: (store, path, callback) => {
    var req = store.delete(path);
    req.onsuccess = event => callback();
    req.onerror = e => {
      callback(e.target.error);
      e.preventDefault();
    };
  },
  reconcile: (src, dst, callback) => {
    var total = 0;
    var create = [];
    for (var [key, e] of Object.entries(src.entries)) {
      var e2 = dst.entries[key];
      if (!e2 || e["timestamp"].getTime() != e2["timestamp"].getTime()) {
        create.push(key);
        total++;
      }
    }
    var remove = [];
    for (var key of Object.keys(dst.entries)) {
      if (!src.entries[key]) {
        remove.push(key);
        total++;
      }
    }
    if (!total) {
      return callback(null);
    }
    var errored = false;
    var db = src.type === "remote" ? src.db : dst.db;
    var transaction = db.transaction([ IDBFS_DB_STORE_NAME ], "readwrite");
    var store = transaction.objectStore(IDBFS_DB_STORE_NAME);
    function done(err) {
      if (err && !errored) {
        errored = true;
        return callback(err);
      }
    }
    // transaction may abort if (for example) there is a QuotaExceededError
    transaction.onerror = transaction.onabort = e => {
      done(e.target.error);
      e.preventDefault();
    };
    transaction.oncomplete = e => {
      if (!errored) {
        callback(null);
      }
    };
    // sort paths in ascending order so directory entries are created
    // before the files inside them
    for (const path of create.sort()) {
      if (dst.type === "local") {
        IDBFS.loadRemoteEntry(store, path, (err, entry) => {
          if (err) return done(err);
          IDBFS.storeLocalEntry(path, entry, done);
        });
      } else {
        IDBFS.loadLocalEntry(path, (err, entry) => {
          if (err) return done(err);
          IDBFS.storeRemoteEntry(store, path, entry, done);
        });
      }
    }
    // sort paths in descending order so files are deleted before their
    // parent directories
    for (var path of remove.sort().reverse()) {
      if (dst.type === "local") {
        IDBFS.removeLocalEntry(path, done);
      } else {
        IDBFS.removeRemoteEntry(store, path, done);
      }
    }
  }
};

var FS_stdin_getChar_buffer = [];

var FS_stdin_getChar = () => {
  if (!FS_stdin_getChar_buffer.length) {
    var result = null;
    if (ENVIRONMENT_IS_NODE) {
      // we will read data by chunks of BUFSIZE
      var BUFSIZE = 256;
      var buf = Buffer.alloc(BUFSIZE);
      var bytesRead = 0;
      try {
        bytesRead = fs.readSync(process.stdin.fd, buf, 0, BUFSIZE);
      } catch (e) {
        // Cross-platform differences: on Windows, reading EOF throws an
        // exception, but on other OSes, reading EOF returns 0. Uniformize
        // behavior by treating the EOF exception to return 0.
        if (e.toString().includes("EOF")) bytesRead = 0; else throw e;
      }
      if (bytesRead > 0) {
        result = buf.toString("utf-8", 0, bytesRead);
      }
    } else if (globalThis.window?.prompt) {
      // Browser.
      result = window.prompt("Input: ");
      // returns null on cancel
      if (result !== null) {
        result += "\n";
      }
    } else {}
    if (!result) {
      return null;
    }
    FS_stdin_getChar_buffer = intArrayFromString(result, true);
  }
  return FS_stdin_getChar_buffer.shift();
};

var UTF8Decoder = globalThis.TextDecoder && new TextDecoder;

/**
   * heapOrArray is either a regular array, or a JavaScript typed array view.
   * @param {number} idx
   * @param {number=} maxBytesToRead
   * @param {boolean=} ignoreNul
   * @return {number}
   */ var findStringEnd = (heapOrArray, idx, maxBytesToRead, ignoreNul) => {
  var maxIdx = idx + maxBytesToRead;
  if (ignoreNul) return maxIdx;
  // TextDecoder needs to know the byte length in advance, it doesn't stop on
  // null terminator by itself.
  // As a tiny code save trick, compare idx against maxIdx using a negation,
  // so that maxBytesToRead=undefined/NaN means Infinity.
  while (heapOrArray[idx] && !(idx >= maxIdx)) ++idx;
  return idx;
};

/**
   * Given a pointer 'idx' to a null-terminated UTF8-encoded string in the given
   * array that contains uint8 values, returns a copy of that string as a
   * Javascript String object.
   * heapOrArray is either a regular array, or a JavaScript typed array view.
   * @param {number=} idx
   * @param {number=} maxBytesToRead
   * @param {boolean=} ignoreNul - If true, the function will not stop on a NUL character.
   * @return {string}
   */ var UTF8ArrayToString = (heapOrArray, idx = 0, maxBytesToRead, ignoreNul) => {
  idx >>>= 0;
  var endPtr = findStringEnd(heapOrArray, idx, maxBytesToRead, ignoreNul);
  // When using conditional TextDecoder, skip it for short strings as the overhead of the native call is not worth it.
  if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
    return UTF8Decoder.decode(heapOrArray.buffer instanceof ArrayBuffer ? heapOrArray.subarray(idx, endPtr) : heapOrArray.slice(idx, endPtr));
  }
  var str = "";
  while (idx < endPtr) {
    // For UTF8 byte structure, see:
    // http://en.wikipedia.org/wiki/UTF-8#Description
    // https://www.ietf.org/rfc/rfc2279.txt
    // https://tools.ietf.org/html/rfc3629
    var u0 = heapOrArray[idx++];
    if (!(u0 & 128)) {
      str += String.fromCharCode(u0);
      continue;
    }
    var u1 = heapOrArray[idx++] & 63;
    if ((u0 & 224) == 192) {
      str += String.fromCharCode(((u0 & 31) << 6) | u1);
      continue;
    }
    var u2 = heapOrArray[idx++] & 63;
    if ((u0 & 240) == 224) {
      u0 = ((u0 & 15) << 12) | (u1 << 6) | u2;
    } else {
      u0 = ((u0 & 7) << 18) | (u1 << 12) | (u2 << 6) | (heapOrArray[idx++] & 63);
    }
    if (u0 < 65536) {
      str += String.fromCharCode(u0);
    } else {
      var ch = u0 - 65536;
      str += String.fromCharCode(55296 | (ch >> 10), 56320 | (ch & 1023));
    }
  }
  return str;
};

var TTY = {
  ttys: [],
  init() {},
  shutdown() {},
  register(dev, ops) {
    TTY.ttys[dev] = {
      input: [],
      output: [],
      ops
    };
    FS.registerDevice(dev, TTY.stream_ops);
  },
  stream_ops: {
    open(stream) {
      var tty = TTY.ttys[stream.node.rdev];
      if (!tty) {
        throw new FS.ErrnoError(43);
      }
      stream.tty = tty;
      stream.seekable = false;
    },
    close(stream) {
      // flush any pending line data
      stream.tty.ops.fsync(stream.tty);
    },
    fsync(stream) {
      stream.tty.ops.fsync(stream.tty);
    },
    read(stream, buffer, offset, length, pos) {
      if (!stream.tty || !stream.tty.ops.get_char) {
        throw new FS.ErrnoError(60);
      }
      var bytesRead = 0;
      for (var i = 0; i < length; i++) {
        var result;
        try {
          result = stream.tty.ops.get_char(stream.tty);
        } catch (e) {
          throw new FS.ErrnoError(29);
        }
        if (result === undefined && !bytesRead) {
          throw new FS.ErrnoError(6);
        }
        if (result === null || result === undefined) break;
        bytesRead++;
        buffer[offset + i] = result;
        // We currently only support canonical mode (ICANON), where
        // read(2) returns as soon as a line delimiter is read.
        if (result === 10) break;
      }
      if (bytesRead) {
        stream.node.atime = Date.now();
      }
      return bytesRead;
    },
    write(stream, buffer, offset, length, pos) {
      if (!stream.tty || !stream.tty.ops.put_char) {
        throw new FS.ErrnoError(60);
      }
      try {
        for (var i = 0; i < length; i++) {
          stream.tty.ops.put_char(stream.tty, buffer[offset + i]);
        }
      } catch (e) {
        throw new FS.ErrnoError(29);
      }
      if (length) {
        stream.node.mtime = stream.node.ctime = Date.now();
      }
      return i;
    }
  },
  default_tty_ops: {
    get_char(tty) {
      return FS_stdin_getChar();
    },
    put_char(tty, val) {
      if (val === null || val === 10) {
        out(UTF8ArrayToString(tty.output));
        tty.output = [];
      } else {
        if (val != 0) tty.output.push(val);
      }
    },
    fsync(tty) {
      if (tty.output?.length > 0) {
        out(UTF8ArrayToString(tty.output));
        tty.output = [];
      }
    },
    ioctl_tcgets(tty) {
      // typical setting
      return {
        c_iflag: 25856,
        c_oflag: 5,
        c_cflag: 191,
        c_lflag: 35387,
        c_cc: [ 3, 28, 127, 21, 4, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ]
      };
    },
    ioctl_tcsets(tty, optional_actions, data) {
      // currently just ignore
      return 0;
    },
    ioctl_tiocgwinsz(tty) {
      return [ 24, 80 ];
    }
  },
  default_tty1_ops: {
    put_char(tty, val) {
      if (val === null || val === 10) {
        err(UTF8ArrayToString(tty.output));
        tty.output = [];
      } else {
        if (val != 0) tty.output.push(val);
      }
    },
    fsync(tty) {
      if (tty.output?.length > 0) {
        err(UTF8ArrayToString(tty.output));
        tty.output = [];
      }
    }
  }
};

var initRandomFill = () => {
  // This block is not needed on v19+ since crypto.getRandomValues is builtin
  if (ENVIRONMENT_IS_NODE) {
    var nodeCrypto = require("node:crypto");
    return view => (nodeCrypto.randomFillSync(view), 0);
  }
  // like with most Web APIs, we can't use Web Crypto API directly on shared memory,
  // so we need to create an intermediate buffer and copy it to the destination
  return view => (view.set(crypto.getRandomValues(new Uint8Array(view.byteLength))), 
  0);
};

var randomFill = view => (randomFill = initRandomFill())(view);

var FS = {
  root: null,
  mounts: [],
  devices: {},
  streams: [],
  nextInode: 1,
  nameTable: [],
  currentPath: "/",
  initialized: false,
  ignorePermissions: true,
  syncFSRequests: 0,
  ErrnoError: class {
    name="ErrnoError";
    // We set the `name` property to be able to identify `FS.ErrnoError`
    // - the `name` is a standard ECMA-262 property of error objects. Kind of good to have it anyway.
    // - when using PROXYFS, an error can come from an underlying FS
    // as different FS objects have their own FS.ErrnoError each,
    // the test `err instanceof FS.ErrnoError` won't detect an error coming from another filesystem, causing bugs.
    // we'll use the reliable test `err.name == "ErrnoError"` instead
    constructor(errno) {
      this.errno = errno;
    }
  },
  FSStream: class {
    shared={};
    get object() {
      return this.node;
    }
    set object(val) {
      this.node = val;
    }
    get isRead() {
      return (this.flags & 2097155) !== 1;
    }
    get isWrite() {
      return (this.flags & 2097155) !== 0;
    }
    get isAppend() {
      return (this.flags & 1024);
    }
    get flags() {
      return this.shared.flags;
    }
    set flags(val) {
      this.shared.flags = val;
    }
    get position() {
      return this.shared.position;
    }
    set position(val) {
      this.shared.position = val;
    }
  },
  FSNode: class {
    node_ops={};
    stream_ops={};
    readMode=292 | 73;
    writeMode=146;
    mounted=null;
    constructor(parent, name, mode, rdev) {
      if (!parent) {
        parent = this;
      }
      this.parent = parent;
      this.mount = parent.mount;
      this.id = FS.nextInode++;
      this.name = name;
      this.mode = mode;
      this.rdev = rdev;
      this.atime = this.mtime = this.ctime = Date.now();
    }
    get read() {
      return (this.mode & this.readMode) === this.readMode;
    }
    set read(val) {
      val ? this.mode |= this.readMode : this.mode &= ~this.readMode;
    }
    get write() {
      return (this.mode & this.writeMode) === this.writeMode;
    }
    set write(val) {
      val ? this.mode |= this.writeMode : this.mode &= ~this.writeMode;
    }
    get isFolder() {
      return FS.isDir(this.mode);
    }
    get isDevice() {
      return FS.isChrdev(this.mode);
    }
    // The per-inode readiness wait-queue. The node carries a Set of listener
    // entries {cb}; producers (SOCKFS, PIPEFS) call notifyListeners on a
    // readiness transition, and poll()/epoll consume it. It lives on the node
    // (not the fd) so dup'd fds share one queue. Only nodes that derive real
    // readiness (sockets, pipes, and an epoll's own node) ever use this -
    // always-ready types (regular files, ttys) never register or notify.
    addListener(cb, exclusive = false) {
      var entry = {
        cb,
        exclusive
      };
      var listeners = (this.listeners ??= new Set);
      listeners.add(entry);
      return {
        listeners,
        entry
      };
    }
    notifyListeners(flags) {
      // Iterates the set without copying, which is safe ONLY under a
      // load-bearing contract that every internal listener must honour:
      //   1. A listener must not run user code synchronously (a poll waiter only
      //      resolves a Promise; an epoll registration only re-lists +
      //      re-notifies; the epoll callback only schedules a tick). User code
      //      runs on a later tick, never inside this loop.
      //   2. A listener may delete entries only from ITS OWN waiter, never from
      //      a sibling node's set that may be mid-iteration. (Deleting an entry
      //      of the set being iterated here is fine - a Set tolerates removal of
      //      a not-yet-visited entry mid-iteration; mutating a *different* node's
      //      set is fine because that set is not being iterated.)
      // Violating either gives silently skipped wakeups that are near-impossible
      // to reproduce. Any new producer/listener must preserve it.
      if (!this.listeners) return;
      // Fire every non-exclusive listener. Among EPOLLEXCLUSIVE registrations
      // (one fd watched by several epolls) wake only one, rotating round-robin
      // per node, to avoid a thundering herd. (Only epoll registrations are ever
      // exclusive; poll waiters and a node's own consumers are not.)
      var excl;
      for (var entry of this.listeners) {
        if (entry.exclusive) (excl ||= []).push(entry); else entry.cb(flags);
      }
      if (excl) {
        var i = (this.exclTurn || 0) % excl.length;
        this.exclTurn = i + 1;
        excl[i].cb(flags);
      }
    }
  },
  lookupPath(path, opts = {}) {
    if (!path) {
      throw new FS.ErrnoError(44);
    }
    opts.follow_mount ??= true;
    if (!PATH.isAbs(path)) {
      path = FS.cwd() + "/" + path;
    }
    // limit max consecutive symlinks to SYMLOOP_MAX.
    linkloop: for (var nlinks = 0; nlinks < 40; nlinks++) {
      // split the absolute path
      var parts = path.split("/").filter(p => !!p);
      // start at the root
      var current = FS.root;
      var current_path = "/";
      for (var i = 0; i < parts.length; i++) {
        var islast = (i === parts.length - 1);
        if (islast && opts.parent) {
          // stop resolving
          break;
        }
        if (parts[i] === ".") {
          continue;
        }
        if (parts[i] === "..") {
          current_path = PATH.dirname(current_path);
          if (FS.isRoot(current)) {
            path = current_path + "/" + parts.slice(i + 1).join("/");
            // We're making progress here, don't let many consecutive ..'s
            // lead to ELOOP
            nlinks--;
            continue linkloop;
          } else {
            current = current.parent;
          }
          continue;
        }
        current_path = PATH.join2(current_path, parts[i]);
        try {
          current = FS.lookupNode(current, parts[i]);
        } catch (e) {
          // if noent_okay is true, suppress a ENOENT in the last component
          // and return an object with an undefined node. This is needed for
          // resolving symlinks in the path when creating a file.
          if ((e?.errno === 44) && islast && opts.noent_okay) {
            return {
              path: current_path
            };
          }
          throw e;
        }
        // jump to the mount's root node if this is a mountpoint
        if (FS.isMountpoint(current) && (!islast || opts.follow_mount)) {
          current = current.mounted.root;
        }
        // by default, lookupPath will not follow a symlink if it is the final path component.
        // setting opts.follow = true will override this behavior.
        if (FS.isLink(current.mode) && (!islast || opts.follow)) {
          if (!current.node_ops.readlink) {
            throw new FS.ErrnoError(52);
          }
          var link = current.node_ops.readlink(current);
          if (!PATH.isAbs(link)) {
            link = PATH.dirname(current_path) + "/" + link;
          }
          path = link + "/" + parts.slice(i + 1).join("/");
          continue linkloop;
        }
      }
      return {
        path: current_path,
        node: current
      };
    }
    throw new FS.ErrnoError(32);
  },
  getPath(node) {
    var path;
    while (true) {
      if (FS.isRoot(node)) {
        var mount = node.mount.mountpoint;
        if (!path) return mount;
        return mount[mount.length - 1] !== "/" ? `${mount}/${path}` : mount + path;
      }
      path = path ? `${node.name}/${path}` : node.name;
      node = node.parent;
    }
  },
  hashName(parentid, name) {
    var hash = 0;
    for (var i = 0; i < name.length; i++) {
      hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    }
    return ((parentid + hash) >>> 0) % FS.nameTable.length;
  },
  hashAddNode(node) {
    var hash = FS.hashName(node.parent.id, node.name);
    node.name_next = FS.nameTable[hash];
    FS.nameTable[hash] = node;
  },
  hashRemoveNode(node) {
    var hash = FS.hashName(node.parent.id, node.name);
    if (FS.nameTable[hash] === node) {
      FS.nameTable[hash] = node.name_next;
    } else {
      var current = FS.nameTable[hash];
      while (current) {
        if (current.name_next === node) {
          current.name_next = node.name_next;
          break;
        }
        current = current.name_next;
      }
    }
  },
  lookupNode(parent, name) {
    var errCode = FS.mayLookup(parent);
    if (errCode) {
      throw new FS.ErrnoError(errCode);
    }
    var hash = FS.hashName(parent.id, name);
    for (var node = FS.nameTable[hash]; node; node = node.name_next) {
      var nodeName = node.name;
      if (node.parent.id === parent.id && nodeName === name) {
        return node;
      }
    }
    // if we failed to find it in the cache, call into the VFS
    return FS.lookup(parent, name);
  },
  createNode(parent, name, mode, rdev = undefined) {
    var node = new FS.FSNode(parent, name, mode, rdev);
    FS.hashAddNode(node);
    return node;
  },
  destroyNode(node) {
    FS.hashRemoveNode(node);
  },
  isRoot(node) {
    return node === node.parent;
  },
  isMountpoint(node) {
    return !!node.mounted;
  },
  isFile(mode) {
    return (mode & 61440) === 32768;
  },
  isDir(mode) {
    return (mode & 61440) === 16384;
  },
  isLink(mode) {
    return (mode & 61440) === 40960;
  },
  isChrdev(mode) {
    return (mode & 61440) === 8192;
  },
  isBlkdev(mode) {
    return (mode & 61440) === 24576;
  },
  isFIFO(mode) {
    return (mode & 61440) === 4096;
  },
  isSocket(mode) {
    return (mode & 49152) === 49152;
  },
  flagsToPermissionString(flag) {
    var perms = [ "r", "w", "rw" ][flag & 3];
    if ((flag & 512)) {
      perms += "w";
    }
    return perms;
  },
  nodePermissions(node, perms) {
    if (FS.ignorePermissions) {
      return 0;
    }
    // return 0 if any user, group or owner bits are set.
    if (perms.includes("r") && !(node.mode & 292)) {
      return 2;
    }
    if (perms.includes("w") && !(node.mode & 146)) {
      return 2;
    }
    if (perms.includes("x") && !(node.mode & 73)) {
      return 2;
    }
    return 0;
  },
  mayLookup(dir) {
    if (!FS.isDir(dir.mode)) return 54;
    var errCode = FS.nodePermissions(dir, "x");
    if (errCode) return errCode;
    if (!dir.node_ops.lookup) return 2;
    return 0;
  },
  mayCreate(dir, name) {
    if (!FS.isDir(dir.mode)) {
      return 54;
    }
    try {
      var node = FS.lookupNode(dir, name);
      return 20;
    } catch (e) {}
    return FS.nodePermissions(dir, "wx");
  },
  mayDelete(dir, name, isdir) {
    var node;
    try {
      node = FS.lookupNode(dir, name);
    } catch (e) {
      return e.errno;
    }
    var errCode = FS.nodePermissions(dir, "wx");
    if (errCode) {
      return errCode;
    }
    if (isdir) {
      if (!FS.isDir(node.mode)) {
        return 54;
      }
      if (FS.isRoot(node) || FS.getPath(node) === FS.cwd()) {
        return 10;
      }
    } else if (FS.isDir(node.mode)) {
      return 31;
    }
    return 0;
  },
  mayOpen(node, flags) {
    if (!node) {
      return 44;
    }
    if (FS.isLink(node.mode)) {
      return 32;
    }
    var mode = FS.flagsToPermissionString(flags);
    if (FS.isDir(node.mode)) {
      // opening for write
      // TODO: check for O_SEARCH? (== search for dir only)
      if (mode !== "r" || (flags & (512 | 64))) {
        return 31;
      }
    }
    return FS.nodePermissions(node, mode);
  },
  checkOpExists(op, err) {
    if (!op) {
      throw new FS.ErrnoError(err);
    }
    return op;
  },
  nextfd() {
    for (var fd = 0; fd <= FS_MAX_OPEN_FDS; fd++) {
      if (!FS.streams[fd]) {
        return fd;
      }
    }
    throw new FS.ErrnoError(33);
  },
  getStreamChecked(fd) {
    var stream = FS.getStream(fd);
    if (!stream) {
      throw new FS.ErrnoError(8);
    }
    return stream;
  },
  getStream: fd => FS.streams[fd],
  createStream(stream, fd = -1) {
    // clone it, so we can return an instance of FSStream
    stream = Object.assign(new FS.FSStream, stream);
    if (fd == -1) {
      fd = FS.nextfd();
    }
    stream.fd = fd;
    FS.streams[fd] = stream;
    return stream;
  },
  closeStream(fd) {
    FS.streams[fd] = null;
  },
  dupStream(origStream, fd = -1) {
    var stream = FS.createStream(origStream, fd);
    stream.stream_ops?.dup?.(stream);
    return stream;
  },
  doSetAttr(stream, node, attr) {
    var setattr = stream?.stream_ops.setattr;
    var arg = setattr ? stream : node;
    setattr ??= node.node_ops.setattr;
    FS.checkOpExists(setattr, 63);
    try {
      setattr(arg, attr);
    } catch (e) {
      if (e instanceof RangeError) {
        throw new FS.ErrnoError(22);
      }
      throw e;
    }
  },
  chrdev_stream_ops: {
    open(stream) {
      var device = FS.getDevice(stream.node.rdev);
      // override node's stream ops with the device's
      stream.stream_ops = device.stream_ops;
      // forward the open call
      stream.stream_ops.open?.(stream);
    },
    llseek() {
      throw new FS.ErrnoError(70);
    }
  },
  major: dev => ((dev) >> 8),
  minor: dev => ((dev) & 255),
  makedev: (ma, mi) => ((ma) << 8 | (mi)),
  registerDevice(dev, ops) {
    FS.devices[dev] = {
      stream_ops: ops
    };
  },
  getDevice: dev => FS.devices[dev],
  getMounts(mount) {
    var mounts = [];
    var check = [ mount ];
    while (check.length) {
      var m = check.pop();
      mounts.push(m);
      check.push(...m.mounts);
    }
    return mounts;
  },
  syncfs(populate, callback) {
    if (typeof populate === "function") {
      callback = populate;
      populate = false;
    }
    FS.syncFSRequests++;
    if (FS.syncFSRequests > 1) {
      err(`warning: ${FS.syncFSRequests} FS.syncfs operations in flight at once, probably just doing extra work`);
    }
    var mounts = FS.getMounts(FS.root.mount);
    var completed = 0;
    function doCallback(errCode) {
      FS.syncFSRequests--;
      return callback(errCode);
    }
    function done(errCode) {
      if (errCode) {
        if (!done.errored) {
          done.errored = true;
          return doCallback(errCode);
        }
        return;
      }
      if (++completed >= mounts.length) {
        doCallback(null);
      }
    }
    // sync all mounts
    for (var mount of mounts) {
      if (mount.type.syncfs) {
        mount.type.syncfs(mount, populate, done);
      } else {
        done(null);
      }
    }
  },
  mount(type, opts, mountpoint) {
    var root = mountpoint === "/";
    var pseudo = !mountpoint;
    var node;
    if (root && FS.root) {
      throw new FS.ErrnoError(10);
    } else if (!root && !pseudo) {
      var lookup = FS.lookupPath(mountpoint, {
        follow_mount: false
      });
      mountpoint = lookup.path;
      // use the absolute path
      node = lookup.node;
      if (FS.isMountpoint(node)) {
        throw new FS.ErrnoError(10);
      }
      if (!FS.isDir(node.mode)) {
        throw new FS.ErrnoError(54);
      }
    }
    var mount = {
      type,
      opts,
      mountpoint,
      mounts: []
    };
    // create a root node for the fs
    var mountRoot = type.mount(mount);
    mountRoot.mount = mount;
    mount.root = mountRoot;
    if (root) {
      FS.root = mountRoot;
    } else if (node) {
      // set as a mountpoint
      node.mounted = mount;
      // add the new mount to the current mount's children
      if (node.mount) {
        node.mount.mounts.push(mount);
      }
    }
    return mountRoot;
  },
  unmount(mountpoint) {
    var lookup = FS.lookupPath(mountpoint, {
      follow_mount: false
    });
    if (!FS.isMountpoint(lookup.node)) {
      throw new FS.ErrnoError(28);
    }
    // destroy the nodes for this mount, and all its child mounts
    var node = lookup.node;
    var mount = node.mounted;
    var mounts = FS.getMounts(mount);
    for (var [hash, current] of Object.entries(FS.nameTable)) {
      while (current) {
        var next = current.name_next;
        if (mounts.includes(current.mount)) {
          FS.destroyNode(current);
        }
        current = next;
      }
    }
    // no longer a mountpoint
    node.mounted = null;
    // remove this mount from the child mounts
    var idx = node.mount.mounts.indexOf(mount);
    node.mount.mounts.splice(idx, 1);
  },
  lookup(parent, name) {
    return parent.node_ops.lookup(parent, name);
  },
  mknod(path, mode, dev) {
    var lookup = FS.lookupPath(path, {
      parent: true
    });
    var parent = lookup.node;
    var name = PATH.basename(path);
    if (!name) {
      throw new FS.ErrnoError(28);
    }
    if (name === "." || name === "..") {
      throw new FS.ErrnoError(20);
    }
    var errCode = FS.mayCreate(parent, name);
    if (errCode) {
      throw new FS.ErrnoError(errCode);
    }
    if (!parent.node_ops.mknod) {
      throw new FS.ErrnoError(63);
    }
    return parent.node_ops.mknod(parent, name, mode, dev);
  },
  statfs(path) {
    return FS.statfsNode(FS.lookupPath(path, {
      follow: true
    }).node);
  },
  statfsStream(stream) {
    // We keep a separate statfsStream function because noderawfs overrides
    // it. In noderawfs, stream.node is sometimes null. Instead, we need to
    // look at stream.path.
    return FS.statfsNode(stream.node);
  },
  statfsNode(node) {
    // NOTE: None of the defaults here are true. We're just returning safe and
    //       sane values. Currently nodefs and rawfs replace these defaults,
    //       other file systems leave them alone.
    var rtn = {
      bsize: 4096,
      frsize: 4096,
      blocks: 1e6,
      bfree: 5e5,
      bavail: 5e5,
      files: FS.nextInode,
      ffree: FS.nextInode - 1,
      fsid: 42,
      flags: 2,
      namelen: 255
    };
    if (node.node_ops.statfs) {
      Object.assign(rtn, node.node_ops.statfs(node.mount.opts.root));
    }
    return rtn;
  },
  create(path, mode = 438) {
    mode &= 4095;
    mode |= 32768;
    return FS.mknod(path, mode, 0);
  },
  mkdir(path, mode = 511) {
    mode &= 511 | 512;
    mode |= 16384;
    return FS.mknod(path, mode, 0);
  },
  mkdirTree(path, mode = 511) {
    var dirs = path.split("/");
    var d = "";
    for (var dir of dirs) {
      if (!dir) continue;
      if (d || PATH.isAbs(path)) d += "/";
      d += dir;
      try {
        FS.mkdir(d, mode);
      } catch (e) {
        if (e.errno != 20) throw e;
      }
    }
  },
  mkdev(path, mode, dev = undefined) {
    if (typeof dev === "undefined") {
      dev = mode;
      mode = 438;
    }
    mode |= 8192;
    return FS.mknod(path, mode, dev);
  },
  symlink(oldpath, newpath) {
    if (!PATH_FS.resolve(oldpath)) {
      throw new FS.ErrnoError(44);
    }
    var lookup = FS.lookupPath(newpath, {
      parent: true
    });
    var parent = lookup.node;
    if (!parent) {
      throw new FS.ErrnoError(44);
    }
    var newname = PATH.basename(newpath);
    var errCode = FS.mayCreate(parent, newname);
    if (errCode) {
      throw new FS.ErrnoError(errCode);
    }
    if (!parent.node_ops.symlink) {
      throw new FS.ErrnoError(63);
    }
    return parent.node_ops.symlink(parent, newname, oldpath);
  },
  link(oldpath, newpath, flags) {
    var lookup = FS.lookupPath(newpath, {
      parent: true
    });
    var parent = lookup.node;
    if (!parent) {
      throw new FS.ErrnoError(44);
    }
    var newname = PATH.basename(newpath);
    var errCode = FS.mayCreate(parent, newname);
    if (errCode) {
      throw new FS.ErrnoError(errCode);
    }
    // Hardlinks are only supported by filesystem backends that provide a
    // `link` node op (e.g. NODERAWFS backed by the host). NODEFS omits it:
    // a host hardlink cannot be confined to the mount root.
    if (!parent.node_ops.link) {
      throw new FS.ErrnoError(34);
    }
    return parent.node_ops.link(parent, newname, oldpath, flags);
  },
  rename(old_path, new_path) {
    var old_dirname = PATH.dirname(old_path);
    var new_dirname = PATH.dirname(new_path);
    var old_name = PATH.basename(old_path);
    var new_name = PATH.basename(new_path);
    // parents must exist
    var lookup, old_dir, new_dir;
    // let the errors from non existent directories percolate up
    lookup = FS.lookupPath(old_path, {
      parent: true
    });
    old_dir = lookup.node;
    lookup = FS.lookupPath(new_path, {
      parent: true
    });
    new_dir = lookup.node;
    if (!old_dir || !new_dir) throw new FS.ErrnoError(44);
    // need to be part of the same mount
    if (old_dir.mount !== new_dir.mount) {
      throw new FS.ErrnoError(75);
    }
    // source must exist
    var old_node = FS.lookupNode(old_dir, old_name);
    // old path should not be an ancestor of the new path
    var relative = PATH_FS.relative(old_path, new_dirname);
    if (relative.charAt(0) !== ".") {
      throw new FS.ErrnoError(28);
    }
    // new path should not be an ancestor of the old path
    relative = PATH_FS.relative(new_path, old_dirname);
    if (relative.charAt(0) !== ".") {
      throw new FS.ErrnoError(55);
    }
    // see if the new path already exists
    var new_node;
    try {
      new_node = FS.lookupNode(new_dir, new_name);
    } catch (e) {}
    // early out if nothing needs to change
    if (old_node === new_node) {
      return;
    }
    // we'll need to delete the old entry
    var isdir = FS.isDir(old_node.mode);
    var errCode = FS.mayDelete(old_dir, old_name, isdir);
    if (errCode) {
      throw new FS.ErrnoError(errCode);
    }
    // need delete permissions if we'll be overwriting.
    // need create permissions if new doesn't already exist.
    errCode = new_node ? FS.mayDelete(new_dir, new_name, isdir) : FS.mayCreate(new_dir, new_name);
    if (errCode) {
      throw new FS.ErrnoError(errCode);
    }
    if (!old_dir.node_ops.rename) {
      throw new FS.ErrnoError(63);
    }
    if (FS.isMountpoint(old_node) || (new_node && FS.isMountpoint(new_node))) {
      throw new FS.ErrnoError(10);
    }
    // if we are going to change the parent, check write permissions
    if (new_dir !== old_dir) {
      errCode = FS.nodePermissions(old_dir, "w");
      if (errCode) {
        throw new FS.ErrnoError(errCode);
      }
    }
    // remove the node from the lookup hash
    FS.hashRemoveNode(old_node);
    // do the underlying fs rename
    try {
      old_dir.node_ops.rename(old_node, new_dir, new_name);
      // The replaced node is stale now. Evict it only after the rename
      // succeeded: backends like NODEFS report node.id as st_ino.
      if (new_node) {
        FS.hashRemoveNode(new_node);
      }
      // update old node (we do this here to avoid each backend
      // needing to)
      old_node.parent = new_dir;
    } catch (e) {
      throw e;
    } finally {
      // add the node back to the hash (in case node_ops.rename
      // changed its name)
      FS.hashAddNode(old_node);
    }
  },
  rmdir(path) {
    var lookup = FS.lookupPath(path, {
      parent: true
    });
    var parent = lookup.node;
    var name = PATH.basename(path);
    var node = FS.lookupNode(parent, name);
    var errCode = FS.mayDelete(parent, name, true);
    if (errCode) {
      throw new FS.ErrnoError(errCode);
    }
    if (!parent.node_ops.rmdir) {
      throw new FS.ErrnoError(63);
    }
    if (FS.isMountpoint(node)) {
      throw new FS.ErrnoError(10);
    }
    parent.node_ops.rmdir(parent, name);
    FS.destroyNode(node);
  },
  readdir(path) {
    var lookup = FS.lookupPath(path, {
      follow: true
    });
    var node = lookup.node;
    var readdir = FS.checkOpExists(node.node_ops.readdir, 54);
    return readdir(node);
  },
  unlink(path) {
    var lookup = FS.lookupPath(path, {
      parent: true
    });
    var parent = lookup.node;
    if (!parent) {
      throw new FS.ErrnoError(44);
    }
    var name = PATH.basename(path);
    var node = FS.lookupNode(parent, name);
    var errCode = FS.mayDelete(parent, name, false);
    if (errCode) {
      // According to POSIX, we should map EISDIR to EPERM, but
      // we instead do what Linux does (and we must, as we use
      // the musl linux libc).
      throw new FS.ErrnoError(errCode);
    }
    if (!parent.node_ops.unlink) {
      throw new FS.ErrnoError(63);
    }
    if (FS.isMountpoint(node)) {
      throw new FS.ErrnoError(10);
    }
    parent.node_ops.unlink(parent, name);
    FS.destroyNode(node);
  },
  readlink(path) {
    var lookup = FS.lookupPath(path);
    var link = lookup.node;
    if (!link) {
      throw new FS.ErrnoError(44);
    }
    if (!link.node_ops.readlink) {
      throw new FS.ErrnoError(28);
    }
    return link.node_ops.readlink(link);
  },
  stat(path, dontFollow = false) {
    var lookup = FS.lookupPath(path, {
      follow: !dontFollow
    });
    var node = lookup.node;
    var getattr = FS.checkOpExists(node.node_ops.getattr, 63);
    return getattr(node);
  },
  fstat(fd) {
    var stream = FS.getStreamChecked(fd);
    var node = stream.node;
    var getattr = stream.stream_ops.getattr;
    var arg = getattr ? stream : node;
    getattr ??= node.node_ops.getattr;
    FS.checkOpExists(getattr, 63);
    return getattr(arg);
  },
  lstat(path) {
    return FS.stat(path, true);
  },
  doChmod(stream, node, mode, dontFollow = false) {
    FS.doSetAttr(stream, node, {
      mode: (mode & 4095) | (node.mode & ~4095),
      ctime: Date.now(),
      dontFollow
    });
  },
  chmod(path, mode, dontFollow = false) {
    var node;
    if (typeof path === "string") {
      var lookup = FS.lookupPath(path, {
        follow: !dontFollow
      });
      node = lookup.node;
    } else {
      node = path;
    }
    FS.doChmod(null, node, mode, dontFollow);
  },
  lchmod(path, mode) {
    FS.chmod(path, mode, true);
  },
  fchmod(fd, mode) {
    var stream = FS.getStreamChecked(fd);
    FS.doChmod(stream, stream.node, mode, false);
  },
  doChown(stream, node, dontFollow = false) {
    FS.doSetAttr(stream, node, {
      timestamp: Date.now(),
      dontFollow
    });
  },
  chown(path, uid, gid, dontFollow = false) {
    var node;
    if (typeof path === "string") {
      var lookup = FS.lookupPath(path, {
        follow: !dontFollow
      });
      node = lookup.node;
    } else {
      node = path;
    }
    FS.doChown(null, node, dontFollow);
  },
  lchown(path, uid, gid) {
    FS.chown(path, uid, gid, true);
  },
  fchown(fd, uid, gid) {
    var stream = FS.getStreamChecked(fd);
    FS.doChown(stream, stream.node, false);
  },
  doTruncate(stream, node, len) {
    if (FS.isDir(node.mode)) {
      throw new FS.ErrnoError(31);
    }
    if (!FS.isFile(node.mode)) {
      throw new FS.ErrnoError(28);
    }
    var errCode = FS.nodePermissions(node, "w");
    if (errCode) {
      throw new FS.ErrnoError(errCode);
    }
    FS.doSetAttr(stream, node, {
      size: len,
      timestamp: Date.now()
    });
  },
  truncate(path, len) {
    if (len < 0) {
      throw new FS.ErrnoError(28);
    }
    var node;
    if (typeof path === "string") {
      var lookup = FS.lookupPath(path, {
        follow: true
      });
      node = lookup.node;
    } else {
      node = path;
    }
    FS.doTruncate(null, node, len);
  },
  ftruncate(fd, len) {
    var stream = FS.getStreamChecked(fd);
    if (len < 0 || (stream.flags & 2097155) === 0) {
      throw new FS.ErrnoError(28);
    }
    FS.doTruncate(stream, stream.node, len);
  },
  utime(path, atime, mtime, dontFollow = false) {
    var lookup = FS.lookupPath(path, {
      follow: !dontFollow
    });
    FS.doSetAttr(null, lookup.node, {
      atime,
      mtime,
      dontFollow
    });
  },
  open(path, flags, mode = 438) {
    if (path === "") {
      throw new FS.ErrnoError(44);
    }
    flags = FS_modeStringToFlags(flags);
    if ((flags & 64)) {
      mode = (mode & 4095) | 32768;
    } else {
      mode = 0;
    }
    var node;
    var isDirPath;
    if (typeof path === "object") {
      node = path;
    } else {
      isDirPath = path.endsWith("/");
      // noent_okay makes it so that if the final component of the path
      // doesn't exist, lookupPath returns `node: undefined`. `path` will be
      // updated to point to the target of all symlinks.
      var lookup = FS.lookupPath(path, {
        follow: !(flags & 131072),
        noent_okay: true
      });
      node = lookup.node;
      path = lookup.path;
    }
    // perhaps we need to create the node
    var created = false;
    if ((flags & 64)) {
      if (node) {
        // if O_CREAT and O_EXCL are set, error out if the node already exists
        if ((flags & 128)) {
          throw new FS.ErrnoError(20);
        }
      } else if (isDirPath) {
        throw new FS.ErrnoError(31);
      } else {
        // node doesn't exist, try to create it
        // Ignore the permission bits here to ensure we can `open` this new
        // file below. We use chmod below to apply the permissions once the
        // file is open.
        node = FS.mknod(path, mode | 511, 0);
        created = true;
      }
    }
    if (!node) {
      throw new FS.ErrnoError(44);
    }
    // can't truncate a device
    if (FS.isChrdev(node.mode)) {
      flags &= ~512;
    }
    // if asked only for a directory, then this must be one
    if ((flags & 65536) && !FS.isDir(node.mode)) {
      throw new FS.ErrnoError(54);
    }
    // check permissions, if this is not a file we just created now (it is ok to
    // create and write to a file with read-only permissions; it is read-only
    // for later use)
    if (!created) {
      var errCode = FS.mayOpen(node, flags);
      if (errCode) {
        throw new FS.ErrnoError(errCode);
      }
    }
    // do truncation if necessary
    if ((flags & 512) && !created) {
      FS.truncate(node, 0);
    }
    // we've already handled these, don't pass down to the underlying vfs
    flags &= ~(128 | 512 | 131072);
    // register the stream with the filesystem
    var stream = FS.createStream({
      node,
      path: FS.getPath(node),
      // we want the absolute path to the node
      flags,
      seekable: true,
      position: 0,
      stream_ops: node.stream_ops,
      // used by the file family libc calls (fopen, fwrite, ferror, etc.)
      ungotten: [],
      error: false
    });
    // call the new stream's open function
    if (stream.stream_ops.open) {
      stream.stream_ops.open(stream);
    }
    if (created) {
      FS.chmod(node, mode & 511);
    }
    return stream;
  },
  close(stream) {
    if (FS.isClosed(stream)) {
      throw new FS.ErrnoError(8);
    }
    if (stream.getdents) stream.getdents = null;
    // free readdir state
    // The fd is going away: wake anything waiting on it (poll/epoll) with
    // POLLNVAL so a blocking wait unblocks and an epoll registration is evicted
    // on its next derive. Only sockets/pipes/epoll ever carry a wait-queue, so
    // for every other stream (incl. nodeless noderawfs stdio) this is a no-op.
    stream.node?.notifyListeners(32);
    try {
      if (stream.stream_ops.close) {
        stream.stream_ops.close(stream);
      }
    } catch (e) {
      throw e;
    } finally {
      FS.closeStream(stream.fd);
    }
    stream.fd = null;
  },
  isClosed(stream) {
    return stream.fd === null;
  },
  llseek(stream, offset, whence) {
    if (FS.isClosed(stream)) {
      throw new FS.ErrnoError(8);
    }
    if (!stream.seekable || !stream.stream_ops.llseek) {
      throw new FS.ErrnoError(70);
    }
    if (whence != 0 && whence != 1 && whence != 2) {
      throw new FS.ErrnoError(28);
    }
    stream.position = stream.stream_ops.llseek(stream, offset, whence);
    stream.ungotten = [];
    return stream.position;
  },
  read(stream, buffer, offset, length, position = undefined) {
    if (length < 0 || position < 0) {
      throw new FS.ErrnoError(28);
    }
    if (FS.isClosed(stream)) {
      throw new FS.ErrnoError(8);
    }
    if ((stream.flags & 2097155) === 1) {
      throw new FS.ErrnoError(8);
    }
    if (FS.isDir(stream.node.mode)) {
      throw new FS.ErrnoError(31);
    }
    if (!stream.stream_ops.read) {
      throw new FS.ErrnoError(28);
    }
    var seeking = typeof position !== "undefined";
    if (!seeking) {
      position = stream.position;
    } else if (!stream.seekable) {
      throw new FS.ErrnoError(70);
    }
    var bytesRead = stream.stream_ops.read(stream, buffer, offset, length, position);
    if (!seeking) stream.position += bytesRead;
    return bytesRead;
  },
  write(stream, buffer, offset, length, position = undefined, canOwn = undefined) {
    if (length < 0 || position < 0) {
      throw new FS.ErrnoError(28);
    }
    if (FS.isClosed(stream)) {
      throw new FS.ErrnoError(8);
    }
    if ((stream.flags & 2097155) === 0) {
      throw new FS.ErrnoError(8);
    }
    if (FS.isDir(stream.node.mode)) {
      throw new FS.ErrnoError(31);
    }
    if (!stream.stream_ops.write) {
      throw new FS.ErrnoError(28);
    }
    if (stream.seekable && stream.flags & 1024) {
      // seek to the end before writing in append mode
      FS.llseek(stream, 0, 2);
    }
    var seeking = typeof position !== "undefined";
    if (!seeking) {
      position = stream.position;
    } else if (!stream.seekable) {
      throw new FS.ErrnoError(70);
    }
    var bytesWritten = stream.stream_ops.write(stream, buffer, offset, length, position, canOwn);
    if (!seeking) stream.position += bytesWritten;
    return bytesWritten;
  },
  mmap(stream, length, position, prot, flags) {
    // User requests writing to file (prot & PROT_WRITE != 0).
    // Checking if we have permissions to write to the file unless
    // MAP_PRIVATE flag is set. According to POSIX spec it is possible
    // to write to file opened in read-only mode with MAP_PRIVATE flag,
    // as all modifications will be visible only in the memory of
    // the current process.
    if ((prot & 2) && !(flags & 2) && (stream.flags & 2097155) !== 2) {
      throw new FS.ErrnoError(2);
    }
    if ((stream.flags & 2097155) === 1) {
      throw new FS.ErrnoError(2);
    }
    if (!stream.stream_ops.mmap) {
      throw new FS.ErrnoError(43);
    }
    if (!length) {
      throw new FS.ErrnoError(28);
    }
    return stream.stream_ops.mmap(stream, length, position, prot, flags);
  },
  msync(stream, buffer, offset, length, mmapFlags) {
    if (!stream.stream_ops.msync) {
      return 0;
    }
    return stream.stream_ops.msync(stream, buffer, offset, length, mmapFlags);
  },
  ioctl(stream, cmd, arg) {
    if (!stream.stream_ops.ioctl) {
      throw new FS.ErrnoError(59);
    }
    return stream.stream_ops.ioctl(stream, cmd, arg);
  },
  readFile(path, opts = {}) {
    opts.flags ??= 0;
    opts.encoding ??= "binary";
    if (opts.encoding !== "utf8" && opts.encoding !== "binary") {
      abort(`Invalid encoding type "${opts.encoding}"`);
    }
    var stream = FS.open(path, opts.flags);
    var stat = FS.stat(path);
    var length = stat.size;
    var buf = new Uint8Array(length);
    FS.read(stream, buf, 0, length, 0);
    if (opts.encoding === "utf8") {
      buf = UTF8ArrayToString(buf);
    }
    FS.close(stream);
    return buf;
  },
  writeFile(path, data, opts = {}) {
    opts.flags ??= 577;
    var stream = FS.open(path, opts.flags, opts.mode);
    data = FS_fileDataToTypedArray(data);
    FS.write(stream, data, 0, data.byteLength, undefined, opts.canOwn);
    FS.close(stream);
  },
  cwd: () => FS.currentPath,
  chdir(path) {
    var lookup = FS.lookupPath(path, {
      follow: true
    });
    if (lookup.node === null) {
      throw new FS.ErrnoError(44);
    }
    if (!FS.isDir(lookup.node.mode)) {
      throw new FS.ErrnoError(54);
    }
    var errCode = FS.nodePermissions(lookup.node, "x");
    if (errCode) {
      throw new FS.ErrnoError(errCode);
    }
    FS.currentPath = lookup.path;
  },
  createDefaultDirectories() {
    FS.mkdir("/tmp");
    FS.mkdir("/home");
    FS.mkdir("/home/web_user");
  },
  createDefaultDevices() {
    // create /dev
    FS.mkdir("/dev");
    // setup /dev/null
    FS.registerDevice(FS.makedev(1, 3), {
      read: () => 0,
      write: (stream, buffer, offset, length, pos) => length,
      llseek: () => 0
    });
    FS.mkdev("/dev/null", FS.makedev(1, 3));
    // setup /dev/tty and /dev/tty1
    // stderr needs to print output using err() rather than out()
    // so we register a second tty just for it.
    TTY.register(FS.makedev(5, 0), TTY.default_tty_ops);
    TTY.register(FS.makedev(6, 0), TTY.default_tty1_ops);
    FS.mkdev("/dev/tty", FS.makedev(5, 0));
    FS.mkdev("/dev/tty1", FS.makedev(6, 0));
    // setup /dev/[u]random
    // use a buffer to avoid overhead of individual crypto calls per byte
    var randomBuffer = new Uint8Array(1024), randomLeft = 0;
    var randomByte = () => {
      if (!randomLeft) {
        randomFill(randomBuffer);
        randomLeft = randomBuffer.byteLength;
      }
      return randomBuffer[--randomLeft];
    };
    FS.createDevice("/dev", "random", randomByte);
    FS.createDevice("/dev", "urandom", randomByte);
    // we're not going to emulate the actual shm device,
    // just create the tmp dirs that reside in it commonly
    FS.mkdir("/dev/shm");
    FS.mkdir("/dev/shm/tmp");
  },
  createSpecialDirectories() {
    // create /proc/self/fd which allows /proc/self/fd/6 => readlink gives the
    // name of the stream for fd 6 (see test_unistd_ttyname)
    FS.mkdir("/proc");
    var proc_self = FS.mkdir("/proc/self");
    FS.mkdir("/proc/self/fd");
    FS.mount({
      mount() {
        var node = FS.createNode(proc_self, "fd", 16895, 73);
        node.stream_ops = {
          llseek: MEMFS.stream_ops.llseek
        };
        node.node_ops = {
          lookup(parent, name) {
            var fd = +name;
            var stream = FS.getStreamChecked(fd);
            var ret = {
              parent: null,
              mount: {
                mountpoint: "fake"
              },
              node_ops: {
                readlink: () => stream.path
              },
              id: fd + 1
            };
            ret.parent = ret;
            // make it look like a simple root node
            return ret;
          },
          readdir() {
            return Array.from(FS.streams.entries()).filter(([k, v]) => v).map(([k, v]) => k.toString());
          }
        };
        return node;
      }
    }, {}, "/proc/self/fd");
  },
  createStandardStreams(input, output, error) {
    // TODO deprecate the old functionality of a single
    // input / output callback and that utilizes FS.createDevice
    // and instead require a unique set of stream ops
    // by default, we symlink the standard streams to the
    // default tty devices. however, if the standard streams
    // have been overwritten we create a unique device for
    // them instead.
    if (input) {
      FS.createDevice("/dev", "stdin", input);
    } else {
      FS.symlink("/dev/tty", "/dev/stdin");
    }
    if (output) {
      FS.createDevice("/dev", "stdout", null, output);
    } else {
      FS.symlink("/dev/tty", "/dev/stdout");
    }
    if (error) {
      FS.createDevice("/dev", "stderr", null, error);
    } else {
      FS.symlink("/dev/tty1", "/dev/stderr");
    }
    // open default streams for the stdin, stdout and stderr devices
    var stdin = FS.open("/dev/stdin", 0);
    var stdout = FS.open("/dev/stdout", 1);
    var stderr = FS.open("/dev/stderr", 1);
  },
  staticInit() {
    FS.nameTable.length = 4096;
    FS.mount(MEMFS, {}, "/");
    FS.createDefaultDirectories();
    FS.createDefaultDevices();
    FS.createSpecialDirectories();
  },
  init(input = undefined, output = undefined, error = undefined) {
    FS.initialized = true;
    // Allow Module.stdin etc. to provide defaults, if none explicitly passed to us here
    input ??= Module["stdin"];
    output ??= Module["stdout"];
    error ??= Module["stderr"];
    FS.createStandardStreams(input, output, error);
  },
  quit() {
    FS.initialized = false;
    // force-flush all streams, so we get musl std streams printed out
    _fflush(0);
    // close all of our streams
    for (var stream of FS.streams) {
      if (stream) {
        FS.close(stream);
      }
    }
  },
  analyzePath(path, dontResolveLastLink = false) {
    // operate from within the context of the symlink's target
    try {
      var lookup = FS.lookupPath(path, {
        follow: !dontResolveLastLink
      });
      path = lookup.path;
    } catch (e) {}
    var ret = {
      isRoot: false,
      exists: false,
      error: 0,
      name: null,
      path: null,
      object: null,
      parentExists: false,
      parentPath: null,
      parentObject: null
    };
    try {
      var lookup = FS.lookupPath(path, {
        parent: true
      });
      ret.parentExists = true;
      ret.parentPath = lookup.path;
      ret.parentObject = lookup.node;
      ret.name = PATH.basename(path);
      lookup = FS.lookupPath(path, {
        follow: !dontResolveLastLink
      });
      ret.exists = true;
      ret.path = lookup.path;
      ret.object = lookup.node;
      ret.name = lookup.node.name;
      ret.isRoot = lookup.path === "/";
    } catch (e) {
      ret.error = e.errno;
    }
    return ret;
  },
  createPath(parent, path, canRead = undefined, canWrite = undefined) {
    parent = typeof parent === "string" ? parent : FS.getPath(parent);
    var parts = path.split("/").reverse();
    while (parts.length) {
      var part = parts.pop();
      if (!part) continue;
      var current = PATH.join2(parent, part);
      try {
        FS.mkdir(current);
      } catch (e) {
        if (e.errno != 20) throw e;
      }
      parent = current;
    }
    return current;
  },
  createFile(parent, name, properties, canRead = undefined, canWrite = undefined) {
    var path = PATH.join2(typeof parent === "string" ? parent : FS.getPath(parent), name);
    var mode = FS_getMode(canRead, canWrite);
    return FS.create(path, mode);
  },
  createDataFile(parent, name, data = undefined, canRead = undefined, canWrite = undefined, canOwn = undefined) {
    var path = name;
    if (parent) {
      parent = typeof parent === "string" ? parent : FS.getPath(parent);
      path = name ? PATH.join2(parent, name) : parent;
    }
    var mode = FS_getMode(canRead, canWrite);
    var node = FS.create(path, mode);
    if (data) {
      data = FS_fileDataToTypedArray(data);
      // make sure we can write to the file
      FS.chmod(node, mode | 146);
      var stream = FS.open(node, 577);
      FS.write(stream, data, 0, data.length, 0, canOwn);
      FS.close(stream);
      FS.chmod(node, mode);
    }
  },
  createDevice(parent, name, input = undefined, output = undefined) {
    var path = PATH.join2(typeof parent === "string" ? parent : FS.getPath(parent), name);
    var mode = FS_getMode(!!input, !!output);
    FS.createDevice.major ??= 64;
    var dev = FS.makedev(FS.createDevice.major++, 0);
    // Create a fake device that a set of stream ops to emulate
    // the old behavior.
    FS.registerDevice(dev, {
      open(stream) {
        stream.seekable = false;
      },
      close(stream) {
        // flush any pending line data
        if (output?.buffer?.length) {
          output(10);
        }
      },
      read(stream, buffer, offset, length, pos) {
        var bytesRead = 0;
        for (var i = 0; i < length; i++) {
          var result;
          try {
            result = input();
          } catch (e) {
            throw new FS.ErrnoError(29);
          }
          if (result === undefined && !bytesRead) {
            throw new FS.ErrnoError(6);
          }
          if (result === null || result === undefined) break;
          bytesRead++;
          buffer[offset + i] = result;
        }
        if (bytesRead) {
          stream.node.atime = Date.now();
        }
        return bytesRead;
      },
      write(stream, buffer, offset, length, pos) {
        for (var i = 0; i < length; i++) {
          try {
            output(buffer[offset + i]);
          } catch (e) {
            throw new FS.ErrnoError(29);
          }
        }
        if (length) {
          stream.node.mtime = stream.node.ctime = Date.now();
        }
        return i;
      }
    });
    return FS.mkdev(path, mode, dev);
  },
  forceLoadFile(obj) {
    if (obj.isDevice || obj.isFolder || obj.link || obj.contents) return true;
    if (globalThis.XMLHttpRequest) {
      abort("Lazy loading should have been performed (contents set) in createLazyFile, but it was not. Lazy loading only works in web workers. Use --embed-file or --preload-file in emcc on the main thread.");
    } else {
      // Command-line.
      try {
        obj.contents = readBinary(obj.url);
      } catch (e) {
        throw new FS.ErrnoError(29);
      }
    }
  },
  createLazyFile(parent, name, url, canRead = undefined, canWrite = undefined) {
    // Lazy chunked Uint8Array (implements get and length from Uint8Array).
    // Actual getting is abstracted away for eventual reuse.
    class LazyUint8Array {
      lengthKnown=false;
      chunks=[];
      // Loaded chunks. Index is the chunk number
      get(idx) {
        if (idx > this.length - 1 || idx < 0) {
          return undefined;
        }
        var chunkOffset = idx % this.chunkSize;
        var chunkNum = (idx / this.chunkSize) | 0;
        return this.getter(chunkNum)[chunkOffset];
      }
      setDataGetter(getter) {
        this.getter = getter;
      }
      cacheLength() {
        // Find length
        var xhr = new XMLHttpRequest;
        xhr.open("HEAD", url, false);
        xhr.send(null);
        if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) abort(`Couldn't load ${url}. Status: ${xhr.status}`);
        var datalength = Number(xhr.getResponseHeader("Content-length"));
        var header;
        var hasByteServing = (header = xhr.getResponseHeader("Accept-Ranges")) && header === "bytes";
        var usesGzip = (header = xhr.getResponseHeader("Content-Encoding")) && header === "gzip";
        var chunkSize = 1024 * 1024;
        // Chunk size in bytes
        if (!hasByteServing) chunkSize = datalength;
        // Function to get a range from the remote URL.
        var doXHR = (from, to) => {
          if (from > to) abort(`invalid range (${from}, ${to}) or no bytes requested!`);
          if (to > datalength - 1) abort(`only ${datalength} bytes available! programmer error!`);
          // TODO: Use mozResponseArrayBuffer, responseStream, etc. if available.
          var xhr = new XMLHttpRequest;
          xhr.open("GET", url, false);
          if (datalength !== chunkSize) xhr.setRequestHeader("Range", `bytes=${from}-${to}`);
          // Some hints to the browser that we want binary data.
          xhr.responseType = "arraybuffer";
          if (xhr.overrideMimeType) {
            xhr.overrideMimeType("text/plain; charset=x-user-defined");
          }
          xhr.send(null);
          if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) abort(`Couldn't load ${url}. Status: ${xhr.status}`);
          if (xhr.response !== undefined) {
            return new Uint8Array(/** @type{Array<number>} */ (xhr.response || []));
          }
          return intArrayFromString(xhr.responseText ?? "", true);
        };
        var lazyArray = this;
        lazyArray.setDataGetter(chunkNum => {
          var start = chunkNum * chunkSize;
          var end = (chunkNum + 1) * chunkSize - 1;
          // including this byte
          end = Math.min(end, datalength - 1);
          // if datalength-1 is selected, this is the last block
          if (typeof lazyArray.chunks[chunkNum] === "undefined") {
            lazyArray.chunks[chunkNum] = doXHR(start, end);
          }
          if (typeof lazyArray.chunks[chunkNum] === "undefined") abort("doXHR failed!");
          return lazyArray.chunks[chunkNum];
        });
        if (usesGzip || !datalength) {
          // if the server uses gzip or doesn't supply the length, we have to download the whole file to get the (uncompressed) length
          chunkSize = datalength = 1;
          // this will force getter(0)/doXHR do download the whole file
          datalength = this.getter(0).length;
          chunkSize = datalength;
          out("LazyFiles on gzip forces download of the whole file when length is accessed");
        }
        this._length = datalength;
        this._chunkSize = chunkSize;
        this.lengthKnown = true;
      }
      get length() {
        if (!this.lengthKnown) {
          this.cacheLength();
        }
        return this._length;
      }
      get chunkSize() {
        if (!this.lengthKnown) {
          this.cacheLength();
        }
        return this._chunkSize;
      }
    }
    if (globalThis.XMLHttpRequest) {
      if (!ENVIRONMENT_IS_WORKER) abort("Cannot do synchronous binary XHRs outside webworkers in modern browsers. Use --embed-file or --preload-file in emcc");
      var lazyArray = new LazyUint8Array;
      var properties = {
        isDevice: false,
        contents: lazyArray
      };
    } else {
      var properties = {
        isDevice: false,
        url
      };
    }
    var node = FS.createFile(parent, name, properties, canRead, canWrite);
    // This is a total hack, but I want to get this lazy file code out of the
    // core of MEMFS. If we want to keep this lazy file concept I feel it should
    // be its own thin LAZYFS proxying calls to MEMFS.
    if (properties.contents) {
      node.contents = properties.contents;
    } else if (properties.url) {
      node.contents = null;
      node.url = properties.url;
    }
    // Add a function that defers querying the file size until it is asked the first time.
    Object.defineProperties(node, {
      usedBytes: {
        get: function() {
          return this.contents.length;
        }
      }
    });
    // override each stream op with one that tries to force load the lazy file first
    var stream_ops = {};
    for (const [key, fn] of Object.entries(node.stream_ops)) {
      stream_ops[key] = (...args) => {
        FS.forceLoadFile(node);
        return fn(...args);
      };
    }
    function writeChunks(stream, buffer, offset, length, position) {
      var contents = stream.node.contents;
      if (position >= contents.length) return 0;
      var size = Math.min(contents.length - position, length);
      if (contents.slice) {
        // normal array
        for (var i = 0; i < size; i++) {
          buffer[offset + i] = contents[position + i];
        }
      } else {
        for (var i = 0; i < size; i++) {
          // LazyUint8Array from sync binary XHR
          buffer[offset + i] = contents.get(position + i);
        }
      }
      return size;
    }
    // use a custom read function
    stream_ops.read = (stream, buffer, offset, length, position) => {
      FS.forceLoadFile(node);
      return writeChunks(stream, buffer, offset, length, position);
    };
    // use a custom mmap function
    stream_ops.mmap = (stream, length, position, prot, flags) => {
      FS.forceLoadFile(node);
      var ptr = mmapAlloc(length);
      if (!ptr) {
        throw new FS.ErrnoError(48);
      }
      writeChunks(stream, (growMemViews(), HEAP8), ptr, length, position);
      return {
        ptr,
        allocated: true
      };
    };
    node.stream_ops = stream_ops;
    return node;
  }
};

/** @type {!Int16Array} */ var HEAP16;

/** @type {!Uint8Array} */ var HEAPU8;

/**
   * Given a pointer 'ptr' to a null-terminated UTF8-encoded string in the
   * emscripten HEAP, returns a copy of that string as a Javascript String object.
   *
   * @param {number} ptr
   * @param {number=} maxBytesToRead - An optional length that specifies the
   *   maximum number of bytes to read. You can omit this parameter to scan the
   *   string until the first 0 byte. If maxBytesToRead is passed, and the string
   *   at [ptr, ptr+maxBytesToReadr[ contains a null byte in the middle, then the
   *   string will cut short at that byte index.
   * @param {boolean=} ignoreNul - If true, the function will not stop on a NUL character.
   * @return {string}
   */ var UTF8ToString = (ptr, maxBytesToRead, ignoreNul) => {
  ptr >>>= 0;
  return ptr ? UTF8ArrayToString((growMemViews(), HEAPU8), ptr, maxBytesToRead, ignoreNul) : "";
};

var SYSCALLS = {
  currentUmask: 18,
  calculateAt(dirfd, path, allowEmpty = false) {
    if (PATH.isAbs(path)) {
      return path;
    }
    // relative path
    var dir;
    if (dirfd === -100) {
      dir = FS.cwd();
    } else {
      var dirstream = SYSCALLS.getStreamFromFD(dirfd);
      dir = dirstream.path;
    }
    if (path.length == 0) {
      if (!allowEmpty) {
        throw new FS.ErrnoError(44);
      }
      return dir;
    }
    return dir + "/" + path;
  },
  writeStat(buf, stat) {
    (growMemViews(), HEAPU32)[((buf) >>> 2) >>> 0] = stat.dev;
    (growMemViews(), HEAPU32)[(((buf) + (4)) >>> 2) >>> 0] = stat.mode;
    (growMemViews(), HEAPU32)[(((buf) + (8)) >>> 2) >>> 0] = stat.nlink;
    (growMemViews(), HEAPU32)[(((buf) + (12)) >>> 2) >>> 0] = stat.uid;
    (growMemViews(), HEAPU32)[(((buf) + (16)) >>> 2) >>> 0] = stat.gid;
    (growMemViews(), HEAPU32)[(((buf) + (20)) >>> 2) >>> 0] = stat.rdev;
    (growMemViews(), HEAP64)[(((buf) + (24)) >>> 3) >>> 0] = BigInt(stat.size);
    (growMemViews(), HEAP32)[(((buf) + (32)) >>> 2) >>> 0] = 4096;
    (growMemViews(), HEAP32)[(((buf) + (36)) >>> 2) >>> 0] = stat.blocks;
    var atime = stat.atime.getTime();
    var mtime = stat.mtime.getTime();
    var ctime = stat.ctime.getTime();
    (growMemViews(), HEAP64)[(((buf) + (40)) >>> 3) >>> 0] = BigInt(Math.floor(atime / 1e3));
    (growMemViews(), HEAPU32)[(((buf) + (48)) >>> 2) >>> 0] = (atime % 1e3) * 1e3 * 1e3;
    (growMemViews(), HEAP64)[(((buf) + (56)) >>> 3) >>> 0] = BigInt(Math.floor(mtime / 1e3));
    (growMemViews(), HEAPU32)[(((buf) + (64)) >>> 2) >>> 0] = (mtime % 1e3) * 1e3 * 1e3;
    (growMemViews(), HEAP64)[(((buf) + (72)) >>> 3) >>> 0] = BigInt(Math.floor(ctime / 1e3));
    (growMemViews(), HEAPU32)[(((buf) + (80)) >>> 2) >>> 0] = (ctime % 1e3) * 1e3 * 1e3;
    (growMemViews(), HEAP64)[(((buf) + (88)) >>> 3) >>> 0] = BigInt(stat.ino);
    return 0;
  },
  writeStatFs(buf, stats) {
    (growMemViews(), HEAPU32)[(((buf) + (4)) >>> 2) >>> 0] = stats.bsize;
    (growMemViews(), HEAPU32)[(((buf) + (60)) >>> 2) >>> 0] = stats.bsize;
    (growMemViews(), HEAP64)[(((buf) + (8)) >>> 3) >>> 0] = BigInt(stats.blocks);
    (growMemViews(), HEAP64)[(((buf) + (16)) >>> 3) >>> 0] = BigInt(stats.bfree);
    (growMemViews(), HEAP64)[(((buf) + (24)) >>> 3) >>> 0] = BigInt(stats.bavail);
    (growMemViews(), HEAP64)[(((buf) + (32)) >>> 3) >>> 0] = BigInt(stats.files);
    (growMemViews(), HEAP64)[(((buf) + (40)) >>> 3) >>> 0] = BigInt(stats.ffree);
    (growMemViews(), HEAPU32)[(((buf) + (48)) >>> 2) >>> 0] = stats.fsid;
    (growMemViews(), HEAPU32)[(((buf) + (64)) >>> 2) >>> 0] = stats.flags;
    // ST_NOSUID
    (growMemViews(), HEAPU32)[(((buf) + (56)) >>> 2) >>> 0] = stats.namelen;
  },
  doMsync(addr, stream, len, flags, offset) {
    if (!FS.isFile(stream.node.mode)) {
      throw new FS.ErrnoError(43);
    }
    if (flags & 2) {
      // MAP_PRIVATE calls need not to be synced back to underlying fs
      return 0;
    }
    var buffer = (growMemViews(), HEAPU8).subarray(addr >>> 0, addr + len >>> 0);
    FS.msync(stream, buffer, offset, len, flags);
  },
  getStreamFromFD(fd) {
    var stream = FS.getStreamChecked(fd);
    return stream;
  },
  varargs: undefined,
  getStr(ptr) {
    var ret = UTF8ToString(ptr);
    return ret;
  }
};

var syscallGetVarargI = () => {
  // the `+` prepended here is necessary to convince the JSCompiler that varargs is indeed a number.
  var ret = (growMemViews(), HEAP32)[((+SYSCALLS.varargs) >>> 2) >>> 0];
  SYSCALLS.varargs += 4;
  return ret;
};

function ___syscall_fcntl64(fd, cmd, varargs) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(3, 0, 1, fd, cmd, varargs);
  varargs >>>= 0;
  SYSCALLS.varargs = varargs;
  try {
    var stream = SYSCALLS.getStreamFromFD(fd);
    switch (cmd) {
     case 0:
      {
        var arg = syscallGetVarargI();
        if (arg < 0) {
          return -28;
        }
        while (FS.streams[arg]) {
          arg++;
        }
        var newStream;
        newStream = FS.dupStream(stream, arg);
        return newStream.fd;
      }

     case 1:
     case 2:
      return 0;

     // FD_CLOEXEC makes no sense for a single process.
      case 3:
      return stream.flags;

     case 4:
      {
        var arg = syscallGetVarargI();
        var mask = 289792;
        stream.flags = (stream.flags & ~mask) | (arg & mask);
        return 0;
      }

     case 12:
      {
        var arg = syscallGetVarargP();
        var offset = 0;
        // We're always unlocked.
        (growMemViews(), HEAP16)[(((arg) + (offset)) >>> 1) >>> 0] = 2;
        return 0;
      }

     case 13:
     case 14:
      // Pretend that the locking is successful. These are process-level locks,
      // and Emscripten programs are a single process. If we supported linking a
      // filesystem between programs, we'd need to do more here.
      // See https://github.com/emscripten-core/emscripten/issues/23697
      return 0;
    }
    return -28;
  } catch (e) {
    if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

function ___syscall_fstat64(fd, buf) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(4, 0, 1, fd, buf);
  buf >>>= 0;
  try {
    return SYSCALLS.writeStat(buf, FS.fstat(fd));
  } catch (e) {
    if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

const INT53_MAX = 9007199254740992;

const INT53_MIN = -9007199254740992;

var bigintToI53Checked = num => (num < INT53_MIN || num > INT53_MAX) ? NaN : Number(num);

function ___syscall_ftruncate64(fd, length) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(5, 0, 1, fd, length);
  length = bigintToI53Checked(length);
  try {
    if (isNaN(length)) return -22;
    FS.ftruncate(fd, length);
    return 0;
  } catch (e) {
    if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

var stringToUTF8 = (str, outPtr, maxBytesToWrite) => stringToUTF8Array(str, (growMemViews(), 
HEAPU8), outPtr, maxBytesToWrite);

function ___syscall_getdents64(fd, dirp, count) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(6, 0, 1, fd, dirp, count);
  dirp >>>= 0;
  count >>>= 0;
  try {
    var stream = SYSCALLS.getStreamFromFD(fd);
    stream.getdents ||= FS.readdir(stream.path);
    var struct_size = 280;
    var pos = 0;
    var off = FS.llseek(stream, 0, 1);
    var startIdx = Math.floor(off / struct_size);
    var endIdx = Math.min(stream.getdents.length, startIdx + Math.floor(count / struct_size));
    for (var idx = startIdx; idx < endIdx; idx++) {
      var id;
      var type;
      var name = stream.getdents[idx];
      if (name === ".") {
        id = stream.node.id;
        type = 4;
      } else if (name === "..") {
        var lookup = FS.lookupPath(stream.path, {
          parent: true
        });
        id = lookup.node.id;
        type = 4;
      } else {
        var child;
        try {
          child = FS.lookupNode(stream.node, name);
        } catch (e) {
          // If the entry is not a directory, file, or symlink, nodefs
          // lookupNode will raise EINVAL. Skip these and continue.
          if (e?.errno === 28) {
            continue;
          }
          throw e;
        }
        id = child.id;
        type = FS.isChrdev(child.mode) ? 2 : // character device.
        FS.isDir(child.mode) ? 4 : // directory
        FS.isLink(child.mode) ? 10 : // symbolic link.
        8;
      }
      (growMemViews(), HEAP64)[((dirp + pos) >>> 3) >>> 0] = BigInt(id);
      (growMemViews(), HEAP64)[(((dirp + pos) + (8)) >>> 3) >>> 0] = BigInt((idx + 1) * struct_size);
      (growMemViews(), HEAP16)[(((dirp + pos) + (16)) >>> 1) >>> 0] = 280;
      (growMemViews(), HEAP8)[(dirp + pos) + (18) >>> 0] = type;
      stringToUTF8(name, dirp + pos + 19, 256);
      pos += struct_size;
    }
    FS.llseek(stream, idx * struct_size, 0);
    return pos;
  } catch (e) {
    if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

function ___syscall_ioctl(fd, op, varargs) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(7, 0, 1, fd, op, varargs);
  varargs >>>= 0;
  SYSCALLS.varargs = varargs;
  try {
    var stream = SYSCALLS.getStreamFromFD(fd);
    switch (op) {
     case 21509:
      {
        if (!stream.tty) return -59;
        return 0;
      }

     case 21505:
      {
        if (!stream.tty) return -59;
        if (stream.tty.ops.ioctl_tcgets) {
          var termios = stream.tty.ops.ioctl_tcgets(stream);
          var argp = syscallGetVarargP();
          (growMemViews(), HEAP32)[((argp) >>> 2) >>> 0] = termios.c_iflag || 0;
          (growMemViews(), HEAP32)[(((argp) + (4)) >>> 2) >>> 0] = termios.c_oflag || 0;
          (growMemViews(), HEAP32)[(((argp) + (8)) >>> 2) >>> 0] = termios.c_cflag || 0;
          (growMemViews(), HEAP32)[(((argp) + (12)) >>> 2) >>> 0] = termios.c_lflag || 0;
          for (var i = 0; i < 32; i++) {
            (growMemViews(), HEAP8)[(argp + i) + (17) >>> 0] = termios.c_cc[i] || 0;
          }
          return 0;
        }
        return 0;
      }

     case 21510:
     case 21511:
     case 21512:
      {
        if (!stream.tty) return -59;
        return 0;
      }

     case 21506:
     case 21507:
     case 21508:
      {
        if (!stream.tty) return -59;
        if (stream.tty.ops.ioctl_tcsets) {
          var argp = syscallGetVarargP();
          var c_iflag = (growMemViews(), HEAP32)[((argp) >>> 2) >>> 0];
          var c_oflag = (growMemViews(), HEAP32)[(((argp) + (4)) >>> 2) >>> 0];
          var c_cflag = (growMemViews(), HEAP32)[(((argp) + (8)) >>> 2) >>> 0];
          var c_lflag = (growMemViews(), HEAP32)[(((argp) + (12)) >>> 2) >>> 0];
          var c_cc = [];
          for (var i = 0; i < 32; i++) {
            c_cc.push((growMemViews(), HEAP8)[(argp + i) + (17) >>> 0]);
          }
          return stream.tty.ops.ioctl_tcsets(stream.tty, op, {
            c_iflag,
            c_oflag,
            c_cflag,
            c_lflag,
            c_cc
          });
        }
        return 0;
      }

     case 21519:
      {
        if (!stream.tty) return -59;
        var argp = syscallGetVarargP();
        (growMemViews(), HEAP32)[((argp) >>> 2) >>> 0] = 0;
        return 0;
      }

     case 21520:
      {
        if (!stream.tty) return -59;
        return -28;
      }

     case 21537:
     case 21531:
      {
        var argp = syscallGetVarargP();
        return FS.ioctl(stream, op, argp);
      }

     case 21523:
      {
        // TODO: in theory we should write to the winsize struct that gets
        // passed in, but for now musl doesn't read anything on it
        if (!stream.tty) return -59;
        if (stream.tty.ops.ioctl_tiocgwinsz) {
          var winsize = stream.tty.ops.ioctl_tiocgwinsz(stream.tty);
          var argp = syscallGetVarargP();
          (growMemViews(), HEAP16)[((argp) >>> 1) >>> 0] = winsize[0];
          (growMemViews(), HEAP16)[(((argp) + (2)) >>> 1) >>> 0] = winsize[1];
        }
        return 0;
      }

     case 21524:
      {
        // TODO: technically, this ioctl call should change the window size.
        // but, since emscripten doesn't have any concept of a terminal window
        // yet, we'll just silently throw it away as we do TIOCGWINSZ
        if (!stream.tty) return -59;
        return 0;
      }

     case 21515:
      {
        if (!stream.tty) return -59;
        return 0;
      }

     default:
      return -28;
    }
  } catch (e) {
    if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

function ___syscall_lstat64(path, buf) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(8, 0, 1, path, buf);
  path >>>= 0;
  buf >>>= 0;
  try {
    path = SYSCALLS.getStr(path);
    return SYSCALLS.writeStat(buf, FS.lstat(path));
  } catch (e) {
    if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

function ___syscall_mkdirat(dirfd, path, mode) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(9, 0, 1, dirfd, path, mode);
  path >>>= 0;
  try {
    path = SYSCALLS.getStr(path);
    path = SYSCALLS.calculateAt(dirfd, path);
    mode &= ~SYSCALLS.currentUmask;
    FS.mkdir(path, mode);
    return 0;
  } catch (e) {
    if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

function ___syscall_newfstatat(dirfd, path, buf, flags) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(10, 0, 1, dirfd, path, buf, flags);
  path >>>= 0;
  buf >>>= 0;
  try {
    path = SYSCALLS.getStr(path);
    var nofollow = flags & 256;
    var allowEmpty = flags & 4096;
    flags = flags & (~6400);
    path = SYSCALLS.calculateAt(dirfd, path, allowEmpty);
    return SYSCALLS.writeStat(buf, nofollow ? FS.lstat(path) : FS.stat(path));
  } catch (e) {
    if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

function ___syscall_openat(dirfd, path, flags, varargs) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(11, 0, 1, dirfd, path, flags, varargs);
  path >>>= 0;
  varargs >>>= 0;
  SYSCALLS.varargs = varargs;
  try {
    path = SYSCALLS.getStr(path);
    path = SYSCALLS.calculateAt(dirfd, path);
    var mode = varargs ? syscallGetVarargI() : 0;
    if (flags & 64) {
      mode &= ~SYSCALLS.currentUmask;
    }
    return FS.open(path, flags, mode).fd;
  } catch (e) {
    if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

function ___syscall_renameat(olddirfd, oldpath, newdirfd, newpath) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(12, 0, 1, olddirfd, oldpath, newdirfd, newpath);
  oldpath >>>= 0;
  newpath >>>= 0;
  try {
    oldpath = SYSCALLS.getStr(oldpath);
    newpath = SYSCALLS.getStr(newpath);
    oldpath = SYSCALLS.calculateAt(olddirfd, oldpath);
    newpath = SYSCALLS.calculateAt(newdirfd, newpath);
    FS.rename(oldpath, newpath);
    return 0;
  } catch (e) {
    if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

function ___syscall_rmdir(path) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(13, 0, 1, path);
  path >>>= 0;
  try {
    path = SYSCALLS.getStr(path);
    FS.rmdir(path);
    return 0;
  } catch (e) {
    if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

function ___syscall_stat64(path, buf) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(14, 0, 1, path, buf);
  path >>>= 0;
  buf >>>= 0;
  try {
    path = SYSCALLS.getStr(path);
    return SYSCALLS.writeStat(buf, FS.stat(path));
  } catch (e) {
    if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

function ___syscall_unlinkat(dirfd, path, flags) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(15, 0, 1, dirfd, path, flags);
  path >>>= 0;
  try {
    path = SYSCALLS.getStr(path);
    path = SYSCALLS.calculateAt(dirfd, path);
    if (!flags) {
      FS.unlink(path);
    } else if (flags === 512) {
      FS.rmdir(path);
    } else {
      return -28;
    }
    return 0;
  } catch (e) {
    if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

function __emscripten_init_main_thread_js(tb) {
  tb >>>= 0;
  var can_block = !ENVIRONMENT_IS_WEB;
  // Feature detect whether the main thread can block.
  try {
    Atomics.wait((growMemViews(), HEAP32), 0, 0, 0);
    can_block = true;
  } catch (e) {}
  // Pass the thread address to the native code where they are stored in wasm
  // globals which act as a form of TLS. Global constructors trying
  // to access this value will read the wrong value, but that is UB anyway.
  __emscripten_thread_init(tb, /*is_main=*/ !ENVIRONMENT_IS_WORKER, /*is_runtime=*/ 1, can_block, /*default_stacksize=*/ 16777216, /*start_profiling=*/ false);
  PThread.threadInitTLS();
}

function __emscripten_notify_mailbox_postmessage(targetThread, currThreadId) {
  targetThread >>>= 0;
  currThreadId >>>= 0;
  if (targetThread == currThreadId) {
    setTimeout(checkMailbox);
  } else if (ENVIRONMENT_IS_PTHREAD) {
    postMessage({
      targetThread,
      cmd: CMD_CHECK_MAILBOX
    });
  } else {
    var worker = PThread.pthreads[targetThread];
    if (!worker) {
      return;
    }
    worker.postMessage({
      cmd: CMD_CHECK_MAILBOX
    });
  }
}

var proxiedJSCallArgs = [];

function __emscripten_receive_on_main_thread_js(funcIndex, emAsmAddr, callingThread, bufSize, args, ctx, ctxArgs) {
  emAsmAddr >>>= 0;
  callingThread >>>= 0;
  args >>>= 0;
  ctx >>>= 0;
  ctxArgs >>>= 0;
  // Sometimes we need to backproxy events to the calling thread (e.g.
  // HTML5 DOM events handlers such as
  // emscripten_set_mousemove_callback()), so keep track in a globally
  // accessible variable about the thread that initiated the proxying.
  proxiedJSCallArgs.length = 0;
  var b = ((args) >>> 3);
  var end = ((args + bufSize) >>> 3);
  while (b < end) {
    var arg;
    if ((growMemViews(), HEAP64)[b++ >>> 0]) {
      // It's a BigInt.
      arg = (growMemViews(), HEAP64)[b++ >>> 0];
    } else {
      // It's a Number.
      arg = (growMemViews(), HEAPF64)[b++ >>> 0];
    }
    proxiedJSCallArgs.push(arg);
  }
  // Proxied JS library funcs use funcIndex and EM_ASM functions use emAsmAddr
  var func = proxiedFunctionTable[funcIndex];
  PThread.currentProxiedOperationCallerThread = callingThread;
  var rtn = func(...proxiedJSCallArgs);
  PThread.currentProxiedOperationCallerThread = 0;
  var coerceRtn = rtn => rtn;
  if (ctx) {
    // A PROXY_SYNC_ASYNC function may complete synchronously with a plain value.
    Promise.resolve(rtn).then(rtn => __emscripten_run_js_on_main_thread_done(ctx, ctxArgs, coerceRtn(rtn)));
    return;
  }
  rtn = coerceRtn(rtn);
  return rtn;
}

function __emscripten_thread_cleanup(thread) {
  thread >>>= 0;
  // Called when a thread needs to be cleaned up so it can be reused.
  // A thread is considered reusable when it either returns from its
  // entry point, calls pthread_exit, or acts upon a cancellation.
  // Detached threads are responsible for calling this themselves,
  // otherwise pthread_join is responsible for calling this.
  if (!ENVIRONMENT_IS_PTHREAD) cleanupThread(thread); else postMessage({
    cmd: CMD_CLEANUP_THREAD,
    thread
  });
}

function __emscripten_thread_set_strongref(thread) {
  thread >>>= 0;
  // Called when a thread needs to be strongly referenced.
  // Currently only used for:
  // - keeping the "main" thread alive in PROXY_TO_PTHREAD mode;
  // - crashed threads that need to propagate the uncaught exception
  //   back to the main thread.
  if (ENVIRONMENT_IS_NODE) {
    var worker = PThread.pthreads[thread];
    worker.ref();
    // Also, record that we called strongref, in case this function is called
    // bafore the 'loaded' callback from the thread (where we would normally
    // `unref` it.
    worker.strongref = 1;
  }
}

function __gmtime_js(time, tmPtr) {
  time = bigintToI53Checked(time);
  tmPtr >>>= 0;
  var date = new Date(time * 1e3);
  if (isNaN(date.getTime())) {
    return 1;
  }
  (growMemViews(), HEAP32)[((tmPtr) >>> 2) >>> 0] = date.getUTCSeconds();
  (growMemViews(), HEAP32)[(((tmPtr) + (4)) >>> 2) >>> 0] = date.getUTCMinutes();
  (growMemViews(), HEAP32)[(((tmPtr) + (8)) >>> 2) >>> 0] = date.getUTCHours();
  (growMemViews(), HEAP32)[(((tmPtr) + (12)) >>> 2) >>> 0] = date.getUTCDate();
  (growMemViews(), HEAP32)[(((tmPtr) + (16)) >>> 2) >>> 0] = date.getUTCMonth();
  (growMemViews(), HEAP32)[(((tmPtr) + (20)) >>> 2) >>> 0] = date.getUTCFullYear() - 1900;
  (growMemViews(), HEAP32)[(((tmPtr) + (24)) >>> 2) >>> 0] = date.getUTCDay();
  var start = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
  var yday = ((date.getTime() - start) / (1e3 * 60 * 60 * 24)) | 0;
  (growMemViews(), HEAP32)[(((tmPtr) + (28)) >>> 2) >>> 0] = yday;
  return 0;
}

var __timegm_js = function(tmPtr) {
  tmPtr >>>= 0;
  var ret = ((() => {
    var time = Date.UTC((growMemViews(), HEAP32)[(((tmPtr) + (20)) >>> 2) >>> 0] + 1900, (growMemViews(), 
    HEAP32)[(((tmPtr) + (16)) >>> 2) >>> 0], (growMemViews(), HEAP32)[(((tmPtr) + (12)) >>> 2) >>> 0], (growMemViews(), 
    HEAP32)[(((tmPtr) + (8)) >>> 2) >>> 0], (growMemViews(), HEAP32)[(((tmPtr) + (4)) >>> 2) >>> 0], (growMemViews(), 
    HEAP32)[((tmPtr) >>> 2) >>> 0], 0);
    var date = new Date(time);
    if (isNaN(date.getTime())) {
      return -1;
    }
    (growMemViews(), HEAP32)[(((tmPtr) + (24)) >>> 2) >>> 0] = date.getUTCDay();
    var start = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
    var yday = ((date.getTime() - start) / (1e3 * 60 * 60 * 24)) | 0;
    (growMemViews(), HEAP32)[(((tmPtr) + (28)) >>> 2) >>> 0] = yday;
    return date.getTime() / 1e3;
  }))();
  return BigInt(ret);
};

var __tzset_js = function(timezone, daylight, std_name, dst_name) {
  timezone >>>= 0;
  daylight >>>= 0;
  std_name >>>= 0;
  dst_name >>>= 0;
  // TODO: Use (malleable) environment variables instead of system settings.
  var currentYear = (new Date).getFullYear();
  var winter = new Date(currentYear, 0, 1);
  var summer = new Date(currentYear, 6, 1);
  var winterOffset = winter.getTimezoneOffset();
  var summerOffset = summer.getTimezoneOffset();
  // Local standard timezone offset. Local standard time is not adjusted for
  // daylight savings.  This code uses the fact that getTimezoneOffset returns
  // a greater value during Standard Time versus Daylight Saving Time (DST).
  // Thus it determines the expected output during Standard Time, and it
  // compares whether the output of the given date the same (Standard) or less
  // (DST).
  var stdTimezoneOffset = Math.max(winterOffset, summerOffset);
  // timezone is specified as seconds west of UTC ("The external variable
  // `timezone` shall be set to the difference, in seconds, between
  // Coordinated Universal Time (UTC) and local standard time."), the same
  // as returned by stdTimezoneOffset.
  // See http://pubs.opengroup.org/onlinepubs/009695399/functions/tzset.html
  (growMemViews(), HEAPU32)[((timezone) >>> 2) >>> 0] = stdTimezoneOffset * 60;
  (growMemViews(), HEAP32)[((daylight) >>> 2) >>> 0] = Number(winterOffset != summerOffset);
  var extractZone = timezoneOffset => {
    // Why inverse sign?
    // Read here https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/getTimezoneOffset
    var sign = timezoneOffset >= 0 ? "-" : "+";
    var absOffset = Math.abs(timezoneOffset);
    var hours = String(Math.floor(absOffset / 60)).padStart(2, "0");
    var minutes = String(absOffset % 60).padStart(2, "0");
    return `UTC${sign}${hours}${minutes}`;
  };
  var winterName = extractZone(winterOffset);
  var summerName = extractZone(summerOffset);
  if (summerOffset < winterOffset) {
    // Northern hemisphere
    stringToUTF8(winterName, std_name, 17);
    stringToUTF8(summerName, dst_name, 17);
  } else {
    stringToUTF8(winterName, dst_name, 17);
    stringToUTF8(summerName, std_name, 17);
  }
};

var checkWasiClock = clock_id => clock_id >= 0 && clock_id <= 3;

const nowIsMonotonic = 1;

var _emscripten_date_now = () => Date.now();

var _emscripten_get_now = () => performance.timeOrigin + performance.now();

function _clock_time_get(clk_id, ignored_precision, ptime) {
  ignored_precision = bigintToI53Checked(ignored_precision);
  ptime >>>= 0;
  if (!checkWasiClock(clk_id)) {
    return 28;
  }
  var now;
  // all wasi clocks but realtime are monotonic
  if (clk_id === 0) {
    now = _emscripten_date_now();
  } else if (nowIsMonotonic) {
    now = _emscripten_get_now();
  } else {
    return 52;
  }
  // "now" is in ms, and wasi times are in ns.
  var nsec = Math.round(now * 1e6);
  (growMemViews(), HEAP64)[((ptime) >>> 3) >>> 0] = BigInt(nsec);
  return 0;
}

var _emscripten_check_blocking_allowed = () => {};

var _emscripten_exit_with_live_runtime = () => {
  runtimeKeepalivePush();
  throw "unwind";
};

var __emscripten_runtime_keepalive_clear = () => {
  noExitRuntime = false;
  runtimeKeepaliveCounter = 0;
};

function _emscripten_force_exit(status) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(16, 0, 1, status);
  __emscripten_runtime_keepalive_clear();
  _exit(status);
}

var jsStackTrace = () => (new Error).stack.toString();

/** @param {number=} flags */ var getCallstack = flags => {
  var callstack = jsStackTrace();
  // Process all lines:
  var lines = callstack.split("\n");
  callstack = "";
  // Extract components of form:
  // '       Object._main@http://server.com:4324:12'
  var firefoxRe = new RegExp("\\s*(.*?)@(.*?):([0-9]+):([0-9]+)");
  // Extract components of form:
  // '    at Object._main (http://server.com/file.html:4324:12)'
  var chromeRe = new RegExp("\\s*at (.*?) \\((.*):(.*):(.*)\\)");
  for (var line of lines) {
    var symbolName = "";
    var file = "";
    var lineno = 0;
    var column = 0;
    var parts = chromeRe.exec(line);
    if (parts?.length == 5) {
      symbolName = parts[1];
      file = parts[2];
      lineno = parts[3];
      column = parts[4];
    } else {
      parts = firefoxRe.exec(line);
      if (parts?.length >= 4) {
        symbolName = parts[1];
        file = parts[2];
        lineno = parts[3];
        // Old Firefox doesn't carry column information, but in new FF30, it
        // is present. See https://bugzil.la/762556
        column = parts[4] | 0;
      } else {
        // Was not able to extract this line for demangling/sourcemapping
        // purposes. Output it as-is.
        callstack += line + "\n";
        continue;
      }
    }
    // Find the symbols in the callstack that corresponds to the functions that
    // report callstack information, and remove everything up to these from the
    // output.
    if (symbolName == "_emscripten_log" || symbolName == "_emscripten_get_callstack") {
      callstack = "";
      continue;
    }
    if ((flags & 24)) {
      if (flags & 64) {
        file = file.substring(file.replace(/\\/g, "/").lastIndexOf("/") + 1);
      }
      callstack += `    at ${symbolName} (${file}:${lineno}:${column})\n`;
    }
  }
  // Trim extra whitespace at the end of the output.
  callstack = callstack.replace(/\s+$/, "");
  return callstack;
};

function _emscripten_get_callstack(flags, str, maxbytes) {
  str >>>= 0;
  var callstack = getCallstack(flags);
  // User can query the required amount of bytes to hold the callstack.
  if (!str || maxbytes <= 0) {
    return lengthBytesUTF8(callstack) + 1;
  }
  // Output callstack string as C string to HEAP.
  var bytesWrittenExcludingNull = stringToUTF8(callstack, str, maxbytes);
  // Return number of bytes written, including null.
  return bytesWrittenExcludingNull + 1;
}

var maybeCStringToJsString = cString => cString > 2 ? UTF8ToString(cString) : cString;

/** @type {Object} */ var specialHTMLTargets = [ 0, globalThis.document ?? 0, globalThis.window ?? 0 ];

var findEventTarget = target => {
  target = maybeCStringToJsString(target);
  var domElement = specialHTMLTargets[target] || globalThis.document?.querySelector(target);
  return domElement;
};

var getCanvasSizeCallingThread = (target, width, height) => {
  var canvas = findCanvasEventTarget(target);
  if (!canvas) return -4;
  if (!canvas.controlTransferredOffscreen) {
    (growMemViews(), HEAP32)[((width) >>> 2) >>> 0] = canvas.width;
    (growMemViews(), HEAP32)[((height) >>> 2) >>> 0] = canvas.height;
  } else {
    return -4;
  }
  return 0;
};

function getCanvasSizeMainThread(target, width, height) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(17, 0, 1, target, width, height);
  return getCanvasSizeCallingThread(target, width, height);
}

function _emscripten_get_canvas_element_size(target, width, height) {
  target >>>= 0;
  width >>>= 0;
  height >>>= 0;
  var canvas = findCanvasEventTarget(target);
  if (canvas) {
    return getCanvasSizeCallingThread(target, width, height);
  }
  return getCanvasSizeMainThread(target, width, height);
}

var _emscripten_num_logical_cores = () => ENVIRONMENT_IS_NODE ? require("node:os").cpus().length : navigator["hardwareConcurrency"];

var alignMemory = (size, alignment) => Math.ceil(size / alignment) * alignment;

var getHeapMax = () => // Stay one Wasm page short of 4GB: while e.g. Chrome is able to allocate
// full 4GB Wasm memories, the size will wrap back to 0 bytes in Wasm side
// for any code that deals with heap sizes, which would require special
// casing all heap size related code to treat 0 specially.
4294901760;

var growMemory = size => {
  var oldHeapSize = wasmMemory.buffer.byteLength;
  var pages = ((size - oldHeapSize + 65535) / 65536) | 0;
  try {
    // round size grow request up to wasm page size (fixed 64KB per spec)
    wasmMemory.grow(pages);
    // .grow() takes a delta compared to the previous size
    updateMemoryViews();
    return 1;
  } catch (e) {}
};

function _emscripten_resize_heap(requestedSize) {
  requestedSize >>>= 0;
  var oldSize = (growMemViews(), HEAPU8).length;
  // With multithreaded builds, races can happen (another thread might increase the size
  // in between), so return a failure, and let the caller retry.
  if (requestedSize <= oldSize) {
    return false;
  }
  // Memory resize rules:
  // 1.  Always increase heap size to at least the requested size, rounded up
  //     to next page multiple.
  // 2a. If MEMORY_GROWTH_LINEAR_STEP == -1, excessively resize the heap
  //     geometrically: increase the heap size according to
  //     MEMORY_GROWTH_GEOMETRIC_STEP factor (default +20%), At most
  //     overreserve by MEMORY_GROWTH_GEOMETRIC_CAP bytes (default 96MB).
  // 2b. If MEMORY_GROWTH_LINEAR_STEP != -1, excessively resize the heap
  //     linearly: increase the heap size by at least
  //     MEMORY_GROWTH_LINEAR_STEP bytes.
  // 3.  Max size for the heap is capped at 2048MB-WASM_PAGE_SIZE, or by
  //     MAXIMUM_MEMORY, or by ASAN limit, depending on which is smallest
  // 4.  If we were unable to allocate as much memory, it may be due to
  //     over-eager decision to excessively reserve due to (3) above.
  //     Hence if an allocation fails, cut down on the amount of excess
  //     growth, in an attempt to succeed to perform a smaller allocation.
  // A limit is set for how much we can grow. We should not exceed that
  // (the wasm binary specifies it, so if we tried, we'd fail anyhow).
  var maxHeapSize = getHeapMax();
  if (requestedSize > maxHeapSize) {
    return false;
  }
  // Loop through potential heap size increases. If we attempt a too eager
  // reservation that fails, cut down on the attempted size and reserve a
  // smaller bump instead. (max 3 times, chosen somewhat arbitrarily)
  for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
    var overGrownHeapSize = oldSize * (1 + .2 / cutDown);
    // ensure geometric growth
    // but limit overreserving (default to capping at +96MB overgrowth at most)
    overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
    var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
    var replacement = growMemory(newSize);
    if (replacement) {
      return true;
    }
  }
  return false;
}

var GLctx;

var getEmscriptenSupportedExtensions = ctx => {
  // Restrict the list of advertised extensions to those that we actually
  // support.
  var supportedExtensions = [ // WebGL 2 extensions
  "EXT_color_buffer_float", "EXT_conservative_depth", "EXT_disjoint_timer_query_webgl2", "EXT_texture_norm16", "NV_shader_noperspective_interpolation", "WEBGL_clip_cull_distance", // WebGL 1 and WebGL 2 extensions
  "EXT_clip_control", "EXT_color_buffer_half_float", "EXT_depth_clamp", "EXT_float_blend", "EXT_polygon_offset_clamp", "EXT_texture_compression_bptc", "EXT_texture_compression_rgtc", "EXT_texture_filter_anisotropic", "KHR_parallel_shader_compile", "OES_texture_float_linear", "WEBGL_blend_func_extended", "WEBGL_compressed_texture_astc", "WEBGL_compressed_texture_etc", "WEBGL_compressed_texture_etc1", "WEBGL_compressed_texture_s3tc", "WEBGL_compressed_texture_s3tc_srgb", "WEBGL_debug_renderer_info", "WEBGL_debug_shaders", "WEBGL_lose_context", "WEBGL_multi_draw", "WEBGL_polygon_mode" ];
  // .getSupportedExtensions() can return null if context is lost, so coerce to empty array.
  return ctx.getSupportedExtensions()?.filter(ext => supportedExtensions.includes(ext)) ?? [];
};

var webgl_enable_EXT_clip_control = ctx => !!(ctx.extClipControl = ctx.getExtension("EXT_clip_control"));

var webgl_enable_EXT_polygon_offset_clamp = ctx => !!(ctx.extPolygonOffsetClamp = ctx.getExtension("EXT_polygon_offset_clamp"));

var webgl_enable_WEBGL_draw_instanced_base_vertex_base_instance = ctx => // Closure is expected to be allowed to minify the '.dibvbi' property, so not accessing it quoted.
!!(ctx.dibvbi = ctx.getExtension("WEBGL_draw_instanced_base_vertex_base_instance"));

var webgl_enable_WEBGL_multi_draw = ctx => // Closure is expected to be allowed to minify the '.multiDrawWebgl' property, so not accessing it quoted.
!!(ctx.multiDrawWebgl = ctx.getExtension("WEBGL_multi_draw"));

var webgl_enable_WEBGL_multi_draw_instanced_base_vertex_base_instance = ctx => !!(ctx.mdibvbi = ctx.getExtension("WEBGL_multi_draw_instanced_base_vertex_base_instance"));

var webgl_enable_WEBGL_polygon_mode = ctx => !!(ctx.webglPolygonMode = ctx.getExtension("WEBGL_polygon_mode"));

var GL = {
  counter: 1,
  buffers: [],
  programs: [],
  framebuffers: [],
  renderbuffers: [],
  textures: [],
  shaders: [],
  vaos: [],
  contexts: {},
  offscreenCanvases: {},
  queries: [],
  samplers: [],
  transformFeedbacks: [],
  syncs: [],
  stringCache: {},
  stringiCache: {},
  unpackAlignment: 4,
  unpackRowLength: 0,
  recordError: errorCode => {
    if (!GL.lastError) {
      GL.lastError = errorCode;
    }
  },
  getNewId: table => {
    var ret = GL.counter++;
    for (var i = table.length; i < ret; i++) {
      table[i] = null;
    }
    return ret;
  },
  genObject: (n, buffers, createFunction, objectTable) => {
    for (var i = 0; i < n; i++) {
      var buffer = GLctx[createFunction]();
      var id = buffer && GL.getNewId(objectTable);
      if (buffer) {
        buffer.name = id;
        objectTable[id] = buffer;
      } else {
        GL.recordError(1282);
      }
      (growMemViews(), HEAP32)[(((buffers) + (i * 4)) >>> 2) >>> 0] = id;
    }
  },
  getSource: (shader, count, string, length) => {
    var source = "";
    for (var i = 0; i < count; ++i) {
      var len = length ? (growMemViews(), HEAPU32)[(((length) + (i * 4)) >>> 2) >>> 0] : undefined;
      source += UTF8ToString((growMemViews(), HEAPU32)[(((string) + (i * 4)) >>> 2) >>> 0], len);
    }
    return source;
  },
  createContext: (/** @type {HTMLCanvasElement} */ canvas, webGLContextAttributes) => {
    // BUG: Workaround Safari WebGL issue: After successfully acquiring WebGL
    // context on a canvas, calling .getContext() will always return that
    // context independent of which 'webgl' or 'webgl2'
    // context version was passed. See:
    //   https://webkit.org/b/222758
    // and:
    //   https://github.com/emscripten-core/emscripten/issues/13295.
    // TODO: Once the bug is fixed and shipped in Safari, adjust the Safari
    // version field in above check.
    if (!canvas.getContextSafariWebGL2Fixed) {
      canvas.getContextSafariWebGL2Fixed = canvas.getContext;
      /** @type {function(this:HTMLCanvasElement, string, (Object|null)=): (RenderingContext|null)} */ function fixedGetContext(ver, attrs) {
        var gl = canvas.getContextSafariWebGL2Fixed(ver, attrs);
        return ((ver == "webgl") == (gl instanceof WebGLRenderingContext)) ? gl : null;
      }
      canvas.getContext = fixedGetContext;
    }
    var ctx = canvas.getContext("webgl2", webGLContextAttributes);
    if (!ctx) return 0;
    var handle = GL.registerContext(ctx, webGLContextAttributes);
    return handle;
  },
  registerContext: (ctx, webGLContextAttributes) => {
    // with pthreads a context is a location in memory with some synchronized
    // data between threads
    var handle = _malloc(8);
    (growMemViews(), HEAPU32)[(((handle) + (4)) >>> 2) >>> 0] = _pthread_self();
    // the thread pointer of the thread that owns the control of the context
    var context = {
      handle,
      attributes: webGLContextAttributes,
      version: webGLContextAttributes.majorVersion,
      GLctx: ctx
    };
    // Store the created context object so that we can access the context
    // given a canvas without having to pass the parameters again.
    if (ctx.canvas) ctx.canvas.GLctxObject = context;
    GL.contexts[handle] = context;
    if (typeof webGLContextAttributes.enableExtensionsByDefault === "undefined" || webGLContextAttributes.enableExtensionsByDefault) {
      GL.initExtensions(context);
    }
    return handle;
  },
  makeContextCurrent: contextHandle => {
    // Active Emscripten GL layer context object.
    GL.currentContext = GL.contexts[contextHandle];
    // Active WebGL context object.
    Module["ctx"] = GLctx = GL.currentContext?.GLctx;
    return !(contextHandle && !GLctx);
  },
  getContext: contextHandle => GL.contexts[contextHandle],
  deleteContext: contextHandle => {
    if (GL.currentContext === GL.contexts[contextHandle]) {
      GL.currentContext = null;
    }
    if (typeof JSEvents === "object") {
      // Release all JS event handlers on the DOM element that the GL context is
      // associated with since the context is now deleted.
      JSEvents.removeAllHandlersOnTarget(GL.contexts[contextHandle].GLctx.canvas);
    }
    // Make sure the canvas object no longer refers to the context object so
    // there are no GC surprises.
    if (GL.contexts[contextHandle]?.GLctx.canvas) {
      GL.contexts[contextHandle].GLctx.canvas.GLctxObject = undefined;
    }
    _free(GL.contexts[contextHandle].handle);
    GL.contexts[contextHandle] = null;
  },
  initExtensions: context => {
    // If this function is called without a specific context object, init the
    // extensions of the currently active context.
    context ||= GL.currentContext;
    if (context.initExtensionsDone) return;
    context.initExtensionsDone = true;
    var gl = context.GLctx;
    // Detect the presence of a few extensions manually, since the GL interop
    // layer itself will need to know if they exist.
    // Extensions that are available in both WebGL 1 and WebGL 2
    webgl_enable_WEBGL_multi_draw(gl);
    webgl_enable_EXT_polygon_offset_clamp(gl);
    webgl_enable_EXT_clip_control(gl);
    webgl_enable_WEBGL_polygon_mode(gl);
    // Extensions that are available from WebGL >= 2 (no-op if called on a WebGL 1 context active)
    webgl_enable_WEBGL_draw_instanced_base_vertex_base_instance(gl);
    webgl_enable_WEBGL_multi_draw_instanced_base_vertex_base_instance(gl);
    // On WebGL 2, EXT_disjoint_timer_query is replaced with an alternative
    // that's based on core APIs, and exposes only the queryCounterEXT()
    // entrypoint.
    if (context.version >= 2) {
      gl.disjointTimerQueryExt = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    }
    // However, Firefox exposes the WebGL 1 version on WebGL 2 as well and
    // thus we look for the WebGL 1 version again if the WebGL 2 version
    // isn't present. https://bugzil.la/1328882
    if (context.version < 2 || !gl.disjointTimerQueryExt) {
      gl.disjointTimerQueryExt = gl.getExtension("EXT_disjoint_timer_query");
    }
    for (var ext of getEmscriptenSupportedExtensions(gl)) {
      // WEBGL_lose_context, WEBGL_debug_renderer_info and WEBGL_debug_shaders
      // are not enabled by default.
      if (!ext.includes("lose_context") && !ext.includes("debug")) {
        // Call .getExtension() to enable that extension permanently.
        gl.getExtension(ext);
      }
    }
  }
};

var webglPowerPreferences = [ "default", "low-power", "high-performance" ];

function __emscripten_webgl_do_create_context(target, attributes) {
  target >>>= 0;
  attributes >>>= 0;
  var attr32 = ((attributes) >>> 2);
  var powerPreference = (growMemViews(), HEAP32)[attr32 + (8 >> 2) >>> 0];
  var contextAttributes = {
    "alpha": !!(growMemViews(), HEAP8)[attributes + 0 >>> 0],
    "depth": !!(growMemViews(), HEAP8)[attributes + 1 >>> 0],
    "stencil": !!(growMemViews(), HEAP8)[attributes + 2 >>> 0],
    "antialias": !!(growMemViews(), HEAP8)[attributes + 3 >>> 0],
    "premultipliedAlpha": !!(growMemViews(), HEAP8)[attributes + 4 >>> 0],
    "preserveDrawingBuffer": !!(growMemViews(), HEAP8)[attributes + 5 >>> 0],
    "powerPreference": webglPowerPreferences[powerPreference],
    "failIfMajorPerformanceCaveat": !!(growMemViews(), HEAP8)[attributes + 12 >>> 0],
    "desynchronized": !!(growMemViews(), HEAP8)[attributes + 33 >>> 0],
    // The following are not predefined WebGL context attributes in the WebGL specification, so the property names can be minified by Closure.
    majorVersion: (growMemViews(), HEAP32)[attr32 + (16 >> 2) >>> 0],
    minorVersion: (growMemViews(), HEAP32)[attr32 + (20 >> 2) >>> 0],
    enableExtensionsByDefault: (growMemViews(), HEAP8)[attributes + 24 >>> 0],
    explicitSwapControl: (growMemViews(), HEAP8)[attributes + 25 >>> 0],
    proxyContextToMainThread: (growMemViews(), HEAP32)[attr32 + (28 >> 2) >>> 0],
    renderViaOffscreenBackBuffer: (growMemViews(), HEAP8)[attributes + 32 >>> 0]
  };
  var canvas = findCanvasEventTarget(target);
  if (!canvas) {
    return 0;
  }
  if (contextAttributes.explicitSwapControl) {
    return 0;
  }
  var contextHandle = GL.createContext(canvas, contextAttributes);
  return contextHandle;
}

function _emscripten_webgl_enable_extension(contextHandle, extension) {
  contextHandle >>>= 0;
  extension >>>= 0;
  var context = GL.getContext(contextHandle);
  var extString = UTF8ToString(extension);
  if (extString.startsWith("GL_")) extString = extString.slice(3);
  // Allow enabling extensions both with "GL_" prefix and without.
  // Switch-board that pulls in code for all GL extensions, even if those are not used :/
  // Build with -sGL_SUPPORT_SIMPLE_ENABLE_EXTENSIONS=0 to avoid this.
  if (extString == "WEBGL_draw_instanced_base_vertex_base_instance") webgl_enable_WEBGL_draw_instanced_base_vertex_base_instance(GLctx);
  if (extString == "WEBGL_multi_draw_instanced_base_vertex_base_instance") webgl_enable_WEBGL_multi_draw_instanced_base_vertex_base_instance(GLctx);
  if (extString == "WEBGL_multi_draw") webgl_enable_WEBGL_multi_draw(GLctx);
  if (extString == "EXT_polygon_offset_clamp") webgl_enable_EXT_polygon_offset_clamp(GLctx);
  if (extString == "EXT_clip_control") webgl_enable_EXT_clip_control(GLctx);
  if (extString == "WEBGL_polygon_mode") webgl_enable_WEBGL_polygon_mode(GLctx);
  var ext = context.GLctx.getExtension(extString);
  return !!ext;
}

function _emscripten_webgl_make_context_current(contextHandle) {
  contextHandle >>>= 0;
  var success = GL.makeContextCurrent(contextHandle);
  return success ? 0 : -5;
}

var ENV = {};

var getExecutableName = () => thisProgram;

var getEnvStrings = () => {
  if (!getEnvStrings.strings) {
    // Default values.
    var lang = (globalThis.navigator?.language ?? "C").replace("-", "_") + ".UTF-8";
    var env = {
      "USER": "web_user",
      "LOGNAME": "web_user",
      "PATH": "/",
      "PWD": "/",
      "HOME": "/home/web_user",
      "LANG": lang,
      "_": getExecutableName()
    };
    // Apply the user-provided values, if any.
    for (var x in ENV) {
      // x is a key in ENV; if ENV[x] is undefined, that means it was
      // explicitly set to be so. We allow user code to do that to
      // force variables with default values to remain unset.
      if (ENV[x] === undefined) delete env[x]; else env[x] = ENV[x];
    }
    var strings = [];
    for (var x in env) {
      strings.push(`${x}=${env[x]}`);
    }
    getEnvStrings.strings = strings;
  }
  return getEnvStrings.strings;
};

function _environ_get(__environ, environ_buf) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(18, 0, 1, __environ, environ_buf);
  __environ >>>= 0;
  environ_buf >>>= 0;
  var bufSize = 0;
  var envp = 0;
  for (var string of getEnvStrings()) {
    var ptr = environ_buf + bufSize;
    (growMemViews(), HEAPU32)[(((__environ) + (envp)) >>> 2) >>> 0] = ptr;
    bufSize += stringToUTF8(string, ptr, Infinity) + 1;
    envp += 4;
  }
  return 0;
}

function _environ_sizes_get(penviron_count, penviron_buf_size) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(19, 0, 1, penviron_count, penviron_buf_size);
  penviron_count >>>= 0;
  penviron_buf_size >>>= 0;
  var strings = getEnvStrings();
  (growMemViews(), HEAPU32)[((penviron_count) >>> 2) >>> 0] = strings.length;
  var bufSize = 0;
  for (var string of strings) {
    bufSize += lengthBytesUTF8(string) + 1;
  }
  (growMemViews(), HEAPU32)[((penviron_buf_size) >>> 2) >>> 0] = bufSize;
  return 0;
}

function _fd_close(fd) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(20, 0, 1, fd);
  try {
    var stream = SYSCALLS.getStreamFromFD(fd);
    FS.close(stream);
    return 0;
  } catch (e) {
    if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
    return e.errno;
  }
}

/** @param {number=} offset */ var doReadv = (stream, iov, iovcnt, offset) => {
  var ret = 0;
  for (var i = 0; i < iovcnt; i++) {
    var ptr = (growMemViews(), HEAPU32)[((iov) >>> 2) >>> 0];
    var len = (growMemViews(), HEAPU32)[(((iov) + (4)) >>> 2) >>> 0];
    iov += 8;
    try {
      var curr = FS.read(stream, (growMemViews(), HEAP8), ptr, len, offset);
    } catch (e) {
      // On a non-blocking stream a subsequent read may would-block after we
      // already gathered data. POSIX readv is a single gather-read: return
      // what we have rather than failing the whole call.
      if (ret > 0 && e instanceof FS.ErrnoError && (e.errno == 6 || e.errno == 6)) {
        break;
      }
      throw e;
    }
    if (curr < 0) return -1;
    ret += curr;
    if (curr < len) break;
    // nothing more to read
    if (typeof offset !== "undefined") {
      offset += curr;
    }
  }
  return ret;
};

function _fd_read(fd, iov, iovcnt, pnum) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(21, 0, 1, fd, iov, iovcnt, pnum);
  iov >>>= 0;
  iovcnt >>>= 0;
  pnum >>>= 0;
  try {
    var stream = SYSCALLS.getStreamFromFD(fd);
    var num = doReadv(stream, iov, iovcnt);
    (growMemViews(), HEAPU32)[((pnum) >>> 2) >>> 0] = num;
    return 0;
  } catch (e) {
    if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
    return e.errno;
  }
}

function _fd_seek(fd, offset, whence, newOffset) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(22, 0, 1, fd, offset, whence, newOffset);
  offset = bigintToI53Checked(offset);
  newOffset >>>= 0;
  try {
    if (isNaN(offset)) return 22;
    var stream = SYSCALLS.getStreamFromFD(fd);
    FS.llseek(stream, offset, whence);
    (growMemViews(), HEAP64)[((newOffset) >>> 3) >>> 0] = BigInt(stream.position);
    if (stream.getdents && !offset && whence === 0) stream.getdents = null;
    // reset readdir state
    return 0;
  } catch (e) {
    if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
    return e.errno;
  }
}

/** @param {number=} offset */ var doWritev = (stream, iov, iovcnt, offset) => {
  // Gather all iovecs into one contiguous buffer and issue a single
  // FS.write, matching POSIX writev's single gather-write semantics (as
  // __syscall_sendmsg already does). Per-iovec writes fragment a stream
  // socket send into multiple segments, breaking stream byte semantics.
  if (iovcnt == 1) {
    // Single iovec: write directly from HEAP8, no gather buffer needed.
    return FS.write(stream, (growMemViews(), HEAP8), (growMemViews(), HEAPU32)[((iov) >>> 2) >>> 0], (growMemViews(), 
    HEAPU32)[(((iov) + (4)) >>> 2) >>> 0], offset);
  }
  var total = 0;
  for (var i = 0, p = iov; i < iovcnt; i++, p += 8) {
    total += (growMemViews(), HEAPU32)[(((p) + (4)) >>> 2) >>> 0];
  }
  var view = new Uint8Array(total);
  var voff = 0;
  for (var i = 0; i < iovcnt; i++, iov += 8) {
    var ptr = (growMemViews(), HEAPU32)[((iov) >>> 2) >>> 0];
    var len = (growMemViews(), HEAPU32)[(((iov) + (4)) >>> 2) >>> 0];
    view.set((growMemViews(), HEAPU8).subarray(ptr >>> 0, ptr + len >>> 0), voff);
    voff += len;
  }
  return FS.write(stream, view, 0, total, offset);
};

function _fd_write(fd, iov, iovcnt, pnum) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(23, 0, 1, fd, iov, iovcnt, pnum);
  iov >>>= 0;
  iovcnt >>>= 0;
  pnum >>>= 0;
  try {
    var stream = SYSCALLS.getStreamFromFD(fd);
    var num = doWritev(stream, iov, iovcnt);
    (growMemViews(), HEAPU32)[((pnum) >>> 2) >>> 0] = num;
    return 0;
  } catch (e) {
    if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
    return e.errno;
  }
}

var _emscripten_glActiveTexture = x0 => GLctx.activeTexture(x0);

var _emscripten_glAttachShader = (program, shader) => {
  GLctx.attachShader(GL.programs[program], GL.shaders[shader]);
};

var _emscripten_glBindBuffer = (target, buffer) => {
  if (target == 35051) {
    // In WebGL 2 glReadPixels entry point, we need to use a different WebGL 2
    // API function call when a buffer is bound to
    // GL_PIXEL_PACK_BUFFER_BINDING point, so must keep track whether that
    // binding point is non-null to know what is the proper API function to
    // call.
    GLctx.currentPixelPackBufferBinding = buffer;
  } else if (target == 35052) {
    // In WebGL 2 gl(Compressed)Tex(Sub)Image[23]D entry points, we need to
    // use a different WebGL 2 API function call when a buffer is bound to
    // GL_PIXEL_UNPACK_BUFFER_BINDING point, so must keep track whether that
    // binding point is non-null to know what is the proper API function to
    // call.
    GLctx.currentPixelUnpackBufferBinding = buffer;
  }
  GLctx.bindBuffer(target, GL.buffers[buffer]);
};

function _emscripten_glBindBufferRange(target, index, buffer, offset, ptrsize) {
  offset >>>= 0;
  ptrsize >>>= 0;
  GLctx.bindBufferRange(target, index, GL.buffers[buffer], offset, ptrsize);
}

var _emscripten_glBindFramebuffer = (target, framebuffer) => {
  GLctx.bindFramebuffer(target, GL.framebuffers[framebuffer]);
};

var _emscripten_glBindSampler = (unit, sampler) => {
  GLctx.bindSampler(unit, GL.samplers[sampler]);
};

var _emscripten_glBindTexture = (target, texture) => {
  GLctx.bindTexture(target, GL.textures[texture]);
};

var _emscripten_glBindVertexArray = vao => {
  GLctx.bindVertexArray(GL.vaos[vao]);
};

var _emscripten_glBlendColor = (x0, x1, x2, x3) => GLctx.blendColor(x0, x1, x2, x3);

var _emscripten_glBlendEquationSeparate = (x0, x1) => GLctx.blendEquationSeparate(x0, x1);

var _emscripten_glBlendFuncSeparate = (x0, x1, x2, x3) => GLctx.blendFuncSeparate(x0, x1, x2, x3);

var _emscripten_glBlitFramebuffer = (x0, x1, x2, x3, x4, x5, x6, x7, x8, x9) => GLctx.blitFramebuffer(x0, x1, x2, x3, x4, x5, x6, x7, x8, x9);

function _emscripten_glBufferData(target, size, data, usage) {
  size >>>= 0;
  data >>>= 0;
  // N.b. here first form specifies a heap subarray, second form an integer
  // size, so the ?: code here is polymorphic. It is advised to avoid
  // randomly mixing both uses in calling code, to avoid any potential JS
  // engine JIT issues.
  GLctx.bufferData(target, data ? (growMemViews(), HEAPU8).subarray(data >>> 0, data + size >>> 0) : size, usage);
}

var webglBufferSubData = (target, offset, size, data, src = (growMemViews(), HEAPU8)) => {
  GLctx.bufferSubData(target, offset, src.subarray(data, data + size));
};

function _emscripten_glBufferSubData(target, offset, size, data) {
  offset >>>= 0;
  size >>>= 0;
  data >>>= 0;
  return webglBufferSubData(target, offset, size, data);
}

var _emscripten_glClearBufferfi = (x0, x1, x2, x3) => GLctx.clearBufferfi(x0, x1, x2, x3);

/** @type {!Float32Array} */ var HEAPF32;

function _emscripten_glClearBufferfv(buffer, drawbuffer, value) {
  value >>>= 0;
  GLctx.clearBufferfv(buffer, drawbuffer, (growMemViews(), HEAPF32), ((value) >>> 2));
}

function _emscripten_glClearBufferiv(buffer, drawbuffer, value) {
  value >>>= 0;
  GLctx.clearBufferiv(buffer, drawbuffer, (growMemViews(), HEAP32), ((value) >>> 2));
}

function _emscripten_glClearBufferuiv(buffer, drawbuffer, value) {
  value >>>= 0;
  GLctx.clearBufferuiv(buffer, drawbuffer, (growMemViews(), HEAPU32), ((value) >>> 2));
}

var _emscripten_glColorMask = (red, green, blue, alpha) => {
  GLctx.colorMask(!!red, !!green, !!blue, !!alpha);
};

var _emscripten_glCompileShader = shader => {
  GLctx.compileShader(GL.shaders[shader]);
};

function _emscripten_glCompressedTexSubImage2D(target, level, xoffset, yoffset, width, height, format, imageSize, data) {
  data >>>= 0;
  if (true) {
    if (GLctx.currentPixelUnpackBufferBinding || !imageSize) {
      GLctx.compressedTexSubImage2D(target, level, xoffset, yoffset, width, height, format, imageSize, data);
      return;
    }
  }
  GLctx.compressedTexSubImage2D(target, level, xoffset, yoffset, width, height, format, (growMemViews(), 
  HEAPU8).subarray(data >>> 0, data + imageSize >>> 0));
}

function _emscripten_glCompressedTexSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, imageSize, data) {
  data >>>= 0;
  if (GLctx.currentPixelUnpackBufferBinding) {
    GLctx.compressedTexSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, imageSize, data);
  } else {
    GLctx.compressedTexSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, (growMemViews(), 
    HEAPU8), data, imageSize);
  }
}

function _emscripten_glCopyBufferSubData(x0, x1, x2, x3, x4) {
  x2 >>>= 0;
  x3 >>>= 0;
  x4 >>>= 0;
  return GLctx.copyBufferSubData(x0, x1, x2, x3, x4);
}

var _emscripten_glCopyTexSubImage2D = (x0, x1, x2, x3, x4, x5, x6, x7) => GLctx.copyTexSubImage2D(x0, x1, x2, x3, x4, x5, x6, x7);

var _emscripten_glCopyTexSubImage3D = (x0, x1, x2, x3, x4, x5, x6, x7, x8) => GLctx.copyTexSubImage3D(x0, x1, x2, x3, x4, x5, x6, x7, x8);

var _emscripten_glCreateProgram = () => {
  var id = GL.getNewId(GL.programs);
  var program = GLctx.createProgram();
  // Store additional information needed for each shader program:
  program.name = id;
  // Lazy cache results of
  // glGetProgramiv(GL_ACTIVE_UNIFORM_MAX_LENGTH/GL_ACTIVE_ATTRIBUTE_MAX_LENGTH/GL_ACTIVE_UNIFORM_BLOCK_MAX_NAME_LENGTH)
  program.maxUniformLength = program.maxAttributeLength = program.maxUniformBlockNameLength = 0;
  program.uniformIdCounter = 1;
  GL.programs[id] = program;
  return id;
};

var _emscripten_glCreateShader = shaderType => {
  var id = GL.getNewId(GL.shaders);
  GL.shaders[id] = GLctx.createShader(shaderType);
  return id;
};

var _emscripten_glCullFace = x0 => GLctx.cullFace(x0);

function _emscripten_glDeleteFramebuffers(n, framebuffers) {
  framebuffers >>>= 0;
  for (var i = 0; i < n; ++i) {
    var id = (growMemViews(), HEAP32)[(((framebuffers) + (i * 4)) >>> 2) >>> 0];
    var framebuffer = GL.framebuffers[id];
    if (!framebuffer) continue;
    // GL spec: "glDeleteFramebuffers silently ignores 0s and names that do not correspond to existing framebuffer objects".
    GLctx.deleteFramebuffer(framebuffer);
    framebuffer.name = 0;
    GL.framebuffers[id] = null;
  }
}

var _emscripten_glDeleteProgram = id => {
  if (!id) return;
  var program = GL.programs[id];
  if (!program) {
    // glDeleteProgram actually signals an error when deleting a nonexisting
    // object, unlike some other GL delete functions.
    GL.recordError(1281);
    return;
  }
  GLctx.deleteProgram(program);
  program.name = 0;
  GL.programs[id] = null;
};

var _emscripten_glDeleteShader = id => {
  if (!id) return;
  var shader = GL.shaders[id];
  if (!shader) {
    // glDeleteShader actually signals an error when deleting a nonexisting
    // object, unlike some other GL delete functions.
    GL.recordError(1281);
    return;
  }
  GLctx.deleteShader(shader);
  GL.shaders[id] = null;
};

var _emscripten_glDepthFunc = x0 => GLctx.depthFunc(x0);

var _emscripten_glDepthMask = flag => {
  GLctx.depthMask(!!flag);
};

var _emscripten_glDepthRangef = (x0, x1) => GLctx.depthRange(x0, x1);

var _emscripten_glDisable = x0 => GLctx.disable(x0);

var _emscripten_glDisableVertexAttribArray = index => {
  GLctx.disableVertexAttribArray(index);
};

var _emscripten_glDrawArrays = (mode, first, count) => {
  GLctx.drawArrays(mode, first, count);
};

var _emscripten_glDrawArraysInstanced = (mode, first, count, primcount) => {
  GLctx.drawArraysInstanced(mode, first, count, primcount);
};

var tempFixedLengthArray = [];

function _emscripten_glDrawBuffers(n, bufs) {
  bufs >>>= 0;
  var bufArray = tempFixedLengthArray[n];
  for (var i = 0; i < n; i++) {
    bufArray[i] = (growMemViews(), HEAP32)[(((bufs) + (i * 4)) >>> 2) >>> 0];
  }
  GLctx.drawBuffers(bufArray);
}

function _emscripten_glDrawElements(mode, count, type, indices) {
  indices >>>= 0;
  GLctx.drawElements(mode, count, type, indices);
}

function _emscripten_glDrawElementsInstanced(mode, count, type, indices, primcount) {
  indices >>>= 0;
  GLctx.drawElementsInstanced(mode, count, type, indices, primcount);
}

var _emscripten_glEnable = x0 => GLctx.enable(x0);

var _emscripten_glEnableVertexAttribArray = index => {
  GLctx.enableVertexAttribArray(index);
};

var _emscripten_glFramebufferTexture2D = (target, attachment, textarget, texture, level) => {
  GLctx.framebufferTexture2D(target, attachment, textarget, GL.textures[texture], level);
};

var _emscripten_glFramebufferTextureLayer = (target, attachment, texture, level, layer) => {
  GLctx.framebufferTextureLayer(target, attachment, GL.textures[texture], level, layer);
};

var _emscripten_glFrontFace = x0 => GLctx.frontFace(x0);

function _emscripten_glGenBuffers(n, buffers) {
  buffers >>>= 0;
  GL.genObject(n, buffers, "createBuffer", GL.buffers);
}

function _emscripten_glGenFramebuffers(n, ids) {
  ids >>>= 0;
  GL.genObject(n, ids, "createFramebuffer", GL.framebuffers);
}

function _emscripten_glGenSamplers(n, samplers) {
  samplers >>>= 0;
  GL.genObject(n, samplers, "createSampler", GL.samplers);
}

function _emscripten_glGenTextures(n, textures) {
  textures >>>= 0;
  GL.genObject(n, textures, "createTexture", GL.textures);
}

function _emscripten_glGenVertexArrays(n, arrays) {
  arrays >>>= 0;
  GL.genObject(n, arrays, "createVertexArray", GL.vaos);
}

function _emscripten_glGetProgramInfoLog(program, maxLength, length, infoLog) {
  length >>>= 0;
  infoLog >>>= 0;
  var log = GLctx.getProgramInfoLog(GL.programs[program]);
  if (log === null) log = "(unknown error)";
  var numBytesWrittenExclNull = (maxLength > 0 && infoLog) ? stringToUTF8(log, infoLog, maxLength) : 0;
  if (length) (growMemViews(), HEAP32)[((length) >>> 2) >>> 0] = numBytesWrittenExclNull;
}

function _emscripten_glGetProgramiv(program, pname, p) {
  p >>>= 0;
  if (!p) {
    // GLES2 specification does not specify how to behave if p is a null
    // pointer. Since calling this function does not make sense if p == null,
    // issue a GL error to notify user about it.
    GL.recordError(1281);
    return;
  }
  if (program >= GL.counter) {
    GL.recordError(1281);
    return;
  }
  program = GL.programs[program];
  if (pname == 35716) {
    // GL_INFO_LOG_LENGTH
    var log = GLctx.getProgramInfoLog(program);
    if (log === null) log = "(unknown error)";
    (growMemViews(), HEAP32)[((p) >>> 2) >>> 0] = log.length + 1;
  } else if (pname == 35719) {
    if (!program.maxUniformLength) {
      var numActiveUniforms = GLctx.getProgramParameter(program, 35718);
      for (var i = 0; i < numActiveUniforms; ++i) {
        program.maxUniformLength = Math.max(program.maxUniformLength, GLctx.getActiveUniform(program, i).name.length + 1);
      }
    }
    (growMemViews(), HEAP32)[((p) >>> 2) >>> 0] = program.maxUniformLength;
  } else if (pname == 35722) {
    if (!program.maxAttributeLength) {
      var numActiveAttributes = GLctx.getProgramParameter(program, 35721);
      for (var i = 0; i < numActiveAttributes; ++i) {
        program.maxAttributeLength = Math.max(program.maxAttributeLength, GLctx.getActiveAttrib(program, i).name.length + 1);
      }
    }
    (growMemViews(), HEAP32)[((p) >>> 2) >>> 0] = program.maxAttributeLength;
  } else if (pname == 35381) {
    if (!program.maxUniformBlockNameLength) {
      var numActiveUniformBlocks = GLctx.getProgramParameter(program, 35382);
      for (var i = 0; i < numActiveUniformBlocks; ++i) {
        program.maxUniformBlockNameLength = Math.max(program.maxUniformBlockNameLength, GLctx.getActiveUniformBlockName(program, i).length + 1);
      }
    }
    (growMemViews(), HEAP32)[((p) >>> 2) >>> 0] = program.maxUniformBlockNameLength;
  } else {
    (growMemViews(), HEAP32)[((p) >>> 2) >>> 0] = GLctx.getProgramParameter(program, pname);
  }
}

function _emscripten_glGetShaderInfoLog(shader, maxLength, length, infoLog) {
  length >>>= 0;
  infoLog >>>= 0;
  var log = GLctx.getShaderInfoLog(GL.shaders[shader]);
  if (log === null) log = "(unknown error)";
  var numBytesWrittenExclNull = (maxLength > 0 && infoLog) ? stringToUTF8(log, infoLog, maxLength) : 0;
  if (length) (growMemViews(), HEAP32)[((length) >>> 2) >>> 0] = numBytesWrittenExclNull;
}

function _emscripten_glGetShaderiv(shader, pname, p) {
  p >>>= 0;
  if (!p) {
    // GLES2 specification does not specify how to behave if p is a null
    // pointer. Since calling this function does not make sense if p == null,
    // issue a GL error to notify user about it.
    GL.recordError(1281);
    return;
  }
  if (pname == 35716) {
    // GL_INFO_LOG_LENGTH
    var log = GLctx.getShaderInfoLog(GL.shaders[shader]);
    if (log === null) log = "(unknown error)";
    // The GLES2 specification says that if the shader has an empty info log,
    // a value of 0 is returned. Otherwise the log has a null char appended.
    // (An empty string is falsey, so we can just check that instead of
    // looking at log.length.)
    var logLength = log ? log.length + 1 : 0;
    (growMemViews(), HEAP32)[((p) >>> 2) >>> 0] = logLength;
  } else if (pname == 35720) {
    // GL_SHADER_SOURCE_LENGTH
    var source = GLctx.getShaderSource(GL.shaders[shader]);
    // source may be a null, or the empty string, both of which are falsey
    // values that we report a 0 length for.
    var sourceLength = source ? source.length + 1 : 0;
    (growMemViews(), HEAP32)[((p) >>> 2) >>> 0] = sourceLength;
  } else {
    (growMemViews(), HEAP32)[((p) >>> 2) >>> 0] = GLctx.getShaderParameter(GL.shaders[shader], pname);
  }
}

function _emscripten_glGetUniformBlockIndex(program, uniformBlockName) {
  uniformBlockName >>>= 0;
  return GLctx.getUniformBlockIndex(GL.programs[program], UTF8ToString(uniformBlockName));
}

/** @suppress {checkTypes} */ var jstoi_q = str => parseInt(str);

/** @noinline */ var webglGetLeftBracePos = name => name.slice(-1) == "]" && name.lastIndexOf("[");

var webglPrepareUniformLocationsBeforeFirstUse = program => {
  var uniformLocsById = program.uniformLocsById, // Maps GLuint -> WebGLUniformLocation
  uniformSizeAndIdsByName = program.uniformSizeAndIdsByName, // Maps name -> [uniform array length, GLuint]
  i, j;
  // On the first time invocation of glGetUniformLocation on this shader program:
  // initialize cache data structures and discover which uniforms are arrays.
  if (!uniformLocsById) {
    // maps GLint integer locations to WebGLUniformLocations
    program.uniformLocsById = uniformLocsById = {};
    // maps integer locations back to uniform name strings, so that we can lazily fetch uniform array locations
    program.uniformArrayNamesById = {};
    var numActiveUniforms = GLctx.getProgramParameter(program, 35718);
    for (i = 0; i < numActiveUniforms; ++i) {
      var u = GLctx.getActiveUniform(program, i);
      var nm = u.name;
      var sz = u.size;
      var lb = webglGetLeftBracePos(nm);
      var arrayName = lb > 0 ? nm.slice(0, lb) : nm;
      // Assign a new location.
      var id = program.uniformIdCounter;
      program.uniformIdCounter += sz;
      // Eagerly get the location of the uniformArray[0] base element.
      // The remaining indices >0 will be left for lazy evaluation to
      // improve performance. Those may never be needed to fetch, if the
      // application fills arrays always in full starting from the first
      // element of the array.
      uniformSizeAndIdsByName[arrayName] = [ sz, id ];
      // Store placeholder integers in place that highlight that these
      // >0 index locations are array indices pending population.
      for (j = 0; j < sz; ++j) {
        uniformLocsById[id] = j;
        program.uniformArrayNamesById[id++] = arrayName;
      }
    }
  }
};

function _emscripten_glGetUniformLocation(program, name) {
  name >>>= 0;
  name = UTF8ToString(name);
  if (program = GL.programs[program]) {
    webglPrepareUniformLocationsBeforeFirstUse(program);
    var uniformLocsById = program.uniformLocsById;
    // Maps GLuint -> WebGLUniformLocation
    var arrayIndex = 0;
    var uniformBaseName = name;
    // Invariant: when populating integer IDs for uniform locations, we must
    // maintain the precondition that arrays reside in contiguous addresses,
    // i.e. for a 'vec4 colors[10];', colors[4] must be at location
    // colors[0]+4.  However, user might call glGetUniformLocation(program,
    // "colors") for an array, so we cannot discover based on the user input
    // arguments whether the uniform we are dealing with is an array. The only
    // way to discover which uniforms are arrays is to enumerate over all the
    // active uniforms in the program.
    var leftBrace = webglGetLeftBracePos(name);
    // If user passed an array accessor "[index]", parse the array index off the accessor.
    if (leftBrace > 0) {
      arrayIndex = jstoi_q(name.slice(leftBrace + 1)) >>> 0;
      // "index]", coerce parseInt(']') with >>>0 to treat "foo[]" as "foo[0]" and foo[-1] as unsigned out-of-bounds.
      uniformBaseName = name.slice(0, leftBrace);
    }
    // Have we cached the location of this uniform before?
    // A pair [array length, GLint of the uniform location]
    var sizeAndId = program.uniformSizeAndIdsByName[uniformBaseName];
    // If a uniform with this name exists, and if its index is within the
    // array limits (if it's even an array), query the WebGLlocation, or
    // return an existing cached location.
    if (sizeAndId && arrayIndex < sizeAndId[0]) {
      arrayIndex += sizeAndId[1];
      // Add the base location of the uniform to the array index offset.
      if ((uniformLocsById[arrayIndex] = uniformLocsById[arrayIndex] || GLctx.getUniformLocation(program, name))) {
        return arrayIndex;
      }
    }
  } else {
    // N.b. we are currently unable to distinguish between GL program IDs that
    // never existed vs GL program IDs that have been deleted, so report
    // GL_INVALID_VALUE in both cases.
    GL.recordError(1281);
  }
  return -1;
}

var _emscripten_glLinkProgram = program => {
  program = GL.programs[program];
  GLctx.linkProgram(program);
  // Invalidate earlier computed uniform->ID mappings, those have now become stale
  program.uniformLocsById = 0;
  // Mark as null-like so that glGetUniformLocation() knows to populate this again.
  program.uniformSizeAndIdsByName = {};
};

var _emscripten_glPixelStorei = (pname, param) => {
  if (pname == 3317) {
    GL.unpackAlignment = param;
  } else if (pname == 3314) {
    GL.unpackRowLength = param;
  }
  GLctx.pixelStorei(pname, param);
};

var _emscripten_glPolygonOffset = (x0, x1) => GLctx.polygonOffset(x0, x1);

var _emscripten_glSamplerParameterf = (sampler, pname, param) => {
  GLctx.samplerParameterf(GL.samplers[sampler], pname, param);
};

var _emscripten_glSamplerParameteri = (sampler, pname, param) => {
  GLctx.samplerParameteri(GL.samplers[sampler], pname, param);
};

var _emscripten_glScissor = (x0, x1, x2, x3) => GLctx.scissor(x0, x1, x2, x3);

function _emscripten_glShaderSource(shader, count, string, length) {
  string >>>= 0;
  length >>>= 0;
  var source = GL.getSource(shader, count, string, length);
  GLctx.shaderSource(GL.shaders[shader], source);
}

var _emscripten_glStencilFuncSeparate = (x0, x1, x2, x3) => GLctx.stencilFuncSeparate(x0, x1, x2, x3);

var _emscripten_glStencilMask = x0 => GLctx.stencilMask(x0);

var _emscripten_glStencilOpSeparate = (x0, x1, x2, x3) => GLctx.stencilOpSeparate(x0, x1, x2, x3);

var _emscripten_glTexParameteri = (x0, x1, x2) => GLctx.texParameteri(x0, x1, x2);

var _emscripten_glTexStorage2D = (x0, x1, x2, x3, x4) => GLctx.texStorage2D(x0, x1, x2, x3, x4);

var _emscripten_glTexStorage3D = (x0, x1, x2, x3, x4, x5) => GLctx.texStorage3D(x0, x1, x2, x3, x4, x5);

var colorChannelsInGlTextureFormat = format => {
  // Micro-optimizations for size: map format to size by subtracting smallest
  // enum value (0x1902) from all values first.  Also omit the most common
  // size value (1) from the list, which is assumed by formats not on the
  // list.
  var colorChannels = {
    // 0x1902 /* GL_DEPTH_COMPONENT */ - 0x1902: 1,
    // 0x1906 /* GL_ALPHA */ - 0x1902: 1,
    5: 3,
    6: 4,
    // 0x1909 /* GL_LUMINANCE */ - 0x1902: 1,
    8: 2,
    29502: 3,
    29504: 4,
    // 0x1903 /* GL_RED */ - 0x1902: 1,
    26917: 2,
    26918: 2,
    // 0x8D94 /* GL_RED_INTEGER */ - 0x1902: 1,
    29846: 3,
    29847: 4
  };
  return colorChannels[format - 6402] || 1;
};

var computeUnpackAlignedImageSize = (width, height, sizePerPixel) => {
  function roundedToNextMultipleOf(x, y) {
    return (x + y - 1) & -y;
  }
  var plainRowSize = (GL.unpackRowLength || width) * sizePerPixel;
  var alignedRowSize = roundedToNextMultipleOf(plainRowSize, GL.unpackAlignment);
  return height * alignedRowSize;
};

/** @type {!Uint16Array} */ var HEAPU16;

var heapObjectForWebGLType = type => {
  // Micro-optimization for size: Subtract lowest GL enum number (0x1400/* GL_BYTE */) from type to compare
  // smaller values for the heap, for shorter generated code size.
  // Also the type HEAPU16 is not tested for explicitly, but any unrecognized type will return out HEAPU16.
  // (since most types are HEAPU16)
  type -= 5120;
  if (type == 0) return growMemViews(), HEAP8;
  if (type == 1) return growMemViews(), HEAPU8;
  if (type == 2) return growMemViews(), HEAP16;
  if (type == 4) return growMemViews(), HEAP32;
  if (type == 6) return growMemViews(), HEAPF32;
  if (type == 5 || type == 28922 || type == 28520 || type == 30779 || type == 30782) return growMemViews(), 
  HEAPU32;
  return growMemViews(), HEAPU16;
};

var toTypedArrayIndex = (pointer, heap) => pointer >>> (31 - Math.clz32(heap.BYTES_PER_ELEMENT));

var emscriptenWebGLGetTexPixelData = (type, format, width, height, pixels) => {
  var heap = heapObjectForWebGLType(type);
  var sizePerPixel = colorChannelsInGlTextureFormat(format) * heap.BYTES_PER_ELEMENT;
  var bytes = computeUnpackAlignedImageSize(width, height, sizePerPixel);
  return heap.subarray(toTypedArrayIndex(pixels, heap) >>> 0, toTypedArrayIndex(pixels + bytes, heap) >>> 0);
};

function _emscripten_glTexSubImage2D(target, level, xoffset, yoffset, width, height, format, type, pixels) {
  pixels >>>= 0;
  if (true) {
    if (GLctx.currentPixelUnpackBufferBinding) {
      GLctx.texSubImage2D(target, level, xoffset, yoffset, width, height, format, type, pixels);
      return;
    }
  }
  var pixelData = pixels ? emscriptenWebGLGetTexPixelData(type, format, width, height, pixels) : null;
  GLctx.texSubImage2D(target, level, xoffset, yoffset, width, height, format, type, pixelData);
}

function _emscripten_glTexSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, pixels) {
  pixels >>>= 0;
  if (GLctx.currentPixelUnpackBufferBinding) {
    GLctx.texSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, pixels);
  } else if (pixels) {
    var heap = heapObjectForWebGLType(type);
    var pixelData = emscriptenWebGLGetTexPixelData(type, format, width, height * depth, pixels);
    GLctx.texSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, pixelData);
  } else {
    GLctx.texSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, null);
  }
}

var webglGetProgramUniformLocation = (program, location) => {
  if (program) {
    var webglLoc = program.uniformLocsById[location];
    // program.uniformLocsById[location] stores either an integer, or a
    // WebGLUniformLocation.
    // If an integer, we have not yet bound the location, so do it now. The
    // integer value specifies the array index we should bind to.
    if (typeof webglLoc === "number") {
      program.uniformLocsById[location] = webglLoc = GLctx.getUniformLocation(program, program.uniformArrayNamesById[location] + (webglLoc > 0 ? `[${webglLoc}]` : ""));
    }
    // Else an already cached WebGLUniformLocation, return it.
    return webglLoc;
  } else {
    GL.recordError(1282);
  }
};

var webglGetUniformLocation = location => webglGetProgramUniformLocation(GLctx.currentProgram, location);

var _emscripten_glUniform1i = (location, v0) => {
  GLctx.uniform1i(webglGetUniformLocation(location), v0);
};

const GL_POOL_TEMP_BUFFERS_SIZE = 288;

var miniTempWebGLIntBuffers = [];

function _emscripten_glUniform1iv(location, count, value) {
  value >>>= 0;
  if (count <= GL_POOL_TEMP_BUFFERS_SIZE) {
    // avoid allocation when uploading few enough uniforms
    var view = miniTempWebGLIntBuffers[count];
    for (var i = 0; i < count; ++i) {
      view[i] = (growMemViews(), HEAP32)[(((value) + (4 * i)) >>> 2) >>> 0];
    }
  } else {
    var view = (growMemViews(), HEAP32).subarray(((value) >>> 2) >>> 0, ((value + count * 4) >>> 2) >>> 0);
  }
  GLctx.uniform1iv(webglGetUniformLocation(location), view);
}

var _emscripten_glUniformBlockBinding = (program, uniformBlockIndex, uniformBlockBinding) => {
  program = GL.programs[program];
  GLctx.uniformBlockBinding(program, uniformBlockIndex, uniformBlockBinding);
};

var _emscripten_glUseProgram = program => {
  program = GL.programs[program];
  GLctx.useProgram(program);
  // Record the currently active program so that we can access the uniform
  // mapping table of that program.
  GLctx.currentProgram = program;
};

var _emscripten_glVertexAttrib4f = (x0, x1, x2, x3, x4) => GLctx.vertexAttrib4f(x0, x1, x2, x3, x4);

var _emscripten_glVertexAttribDivisor = (index, divisor) => {
  GLctx.vertexAttribDivisor(index, divisor);
};

function _emscripten_glVertexAttribIPointer(index, size, type, stride, ptr) {
  ptr >>>= 0;
  GLctx.vertexAttribIPointer(index, size, type, stride, ptr);
}

function _emscripten_glVertexAttribPointer(index, size, type, normalized, stride, ptr) {
  ptr >>>= 0;
  GLctx.vertexAttribPointer(index, size, type, !!normalized, stride, ptr);
}

var _emscripten_glViewport = (x0, x1, x2, x3) => GLctx.viewport(x0, x1, x2, x3);

var stringToNewUTF8 = str => {
  var size = lengthBytesUTF8(str) + 1;
  var ret = _malloc(size);
  if (ret) stringToUTF8(str, ret, size);
  return ret;
};

var _host_gamepad = function(index, buttons, triggers, sticks) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(24, 0, 1, index, buttons, triggers, sticks);
  buttons >>>= 0;
  triggers >>>= 0;
  sticks >>>= 0;
  const pads = typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : [];
  const p = Array.from(pads).filter(x => x && x.connected)[index];
  if (!p) return 0;
  const b = p.buttons, on = i => b[i] && b[i].pressed;
  const bits = [ [ 12, 1 ], [ 13, 2 ], [ 14, 4 ], [ 15, 8 ], [ 9, 16 ], [ 8, 32 ], [ 10, 64 ], [ 11, 128 ], [ 4, 256 ], [ 5, 512 ], [ 16, 1024 ], [ 0, 4096 ], [ 1, 8192 ], [ 2, 16384 ], [ 3, 32768 ] ];
  let m = 0;
  for (const [i, bit] of bits) if (on(i)) m |= bit;
  (growMemViews(), HEAPU16)[buttons / 2 >>> 0] = m;
  (growMemViews(), HEAPU8)[triggers >>> 0] = Math.round((b[6] ? b[6].value : 0) * 255);
  (growMemViews(), HEAPU8)[triggers + 1 >>> 0] = Math.round((b[7] ? b[7].value : 0) * 255);
  const ax = (i, flip) => {
    const v = (p.axes[i] || 0) * (flip ? -1 : 1);
    return Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  };
  (growMemViews(), HEAP16)[sticks / 2 >>> 0] = ax(0);
  (growMemViews(), HEAP16)[sticks / 2 + 1 >>> 0] = ax(1, true);
  (growMemViews(), HEAP16)[sticks / 2 + 2 >>> 0] = ax(2);
  (growMemViews(), HEAP16)[sticks / 2 + 3 >>> 0] = ax(3, true);
  return 1;
};

var _host_lock_pointer = function(lock) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(25, 0, 1, lock);
  const c = Module.canvas;
  if (!c || typeof document === "undefined") return;
  Module.uewWantLock = !!lock;
  if (!lock && document.pointerLockElement === c) document.exitPointerLock();
  if (lock && !Module.uewLockHooked) {
    Module.uewLockHooked = true;
    // the browser refuses a lock right after the user left one (Esc); the next click asks again
    c.addEventListener("click", () => {
      if (!Module.uewWantLock || document.pointerLockElement === c) return;
      try {
        const p = c.requestPointerLock();
        if (p && p.catch) p.catch(() => {});
      } catch (e) {}
    });
  }
};

function _host_open_url(p) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(26, 0, 1, p);
  p >>>= 0;
  if (typeof document === "undefined") return 0;
  const url = UTF8ToString(p);
  if (!/^https?:\/\//i.test(url)) return 0;
  console.log("[web] the game opens " + url);
  let w = null;
  try {
    w = window.open(url, "_blank", "noopener");
  } catch (e) {}
  if (w) return 1;
  const bar = document.createElement("div");
  bar.style.cssText = "position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;background:#1b1f24;color:#e6e6e6;" + "font:14px system-ui,sans-serif;padding:10px 14px;border-radius:8px;box-shadow:0 6px 24px #000a;display:flex;gap:12px;align-items:center";
  const host = ((() => {
    try {
      return new URL(url).host;
    } catch (e) {
      return url;
    }
  }))();
  bar.innerHTML = '<span>The game wants to open <b></b></span><button style="padding:6px 12px;border:0;border-radius:4px;background:#2d73ff;color:#fff;cursor:pointer">Open</button><a href="#" style="color:#9aa">Not now</a>';
  bar.querySelector("b").textContent = host;
  bar.querySelector("button").onclick = () => {
    window.open(url, "_blank", "noopener");
    bar.remove();
  };
  bar.querySelector("a").onclick = e => {
    e.preventDefault();
    bar.remove();
  };
  document.body.appendChild(bar);
  return 1;
}

function _host_page_int(name) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(27, 0, 1, name);
  name >>>= 0;
  const v = typeof Module !== "undefined" ? Module[UTF8ToString(name)] : 0;
  return v ? v | 0 : 0;
}

function _host_query_flag(name) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(28, 0, 1, name);
  name >>>= 0;
  if (typeof location === "undefined") return 0;
  return new RegExp("[?&]" + UTF8ToString(name) + "=1(&|$)").test(location.search) ? 1 : 0;
}

function _host_query_hex(name) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(29, 0, 1, name);
  name >>>= 0;
  if (typeof location === "undefined") return 0;
  const m = new RegExp("[?&]" + UTF8ToString(name) + "=([0-9a-fA-F]+)(&|$)").exec(location.search);
  return m ? parseInt(m[1], 16) : 0;
}

function _host_query_int(name) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(30, 0, 1, name);
  name >>>= 0;
  if (typeof location === "undefined") return 0;
  const m = new RegExp("[?&]" + UTF8ToString(name) + "=(\\d+)").exec(location.search);
  return m ? +m[1] : 0;
}

var _host_rumble = function(index, lo, hi) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(31, 0, 1, index, lo, hi);
  const pads = typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : [];
  const p = Array.from(pads).filter(x => x && x.connected)[index];
  const a = p && p.vibrationActuator;
  if (a && a.playEffect) a.playEffect("dual-rumble", {
    duration: 200,
    strongMagnitude: lo / 65535,
    weakMagnitude: hi / 65535
  }).catch(() => {});
};

function _host_show_cursor(show) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(32, 0, 1, show);
  const c = Module.canvas;
  if (c) c.style.cursor = show ? "default" : "none";
}

function _inet_claims(host) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(33, 0, 1, host);
  host >>>= 0;
  const n = Module.uewNet;
  return n && n.http && (!n.claim || n.claim(UTF8ToString(host))) ? 1 : 0;
}

function _inet_request(method, url, headers, body, len, status, hlen) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(34, 0, 1, method, url, headers, body, len, status, hlen);
  method >>>= 0;
  url >>>= 0;
  headers >>>= 0;
  body >>>= 0;
  status >>>= 0;
  hlen >>>= 0;
  const n = Module.uewNet;
  let r;
  try {
    r = n.http({
      method: UTF8ToString(method),
      url: UTF8ToString(url),
      headers: UTF8ToString(headers),
      body: (growMemViews(), HEAPU8).slice(body, body + len)
    });
  } catch (e) {
    console.log("[net] handler failed: " + e);
    r = {
      status: 500,
      headers: {},
      body: ""
    };
  }
  r = r || {
    status: 404,
    headers: {},
    body: ""
  };
  let b = r.body;
  if (typeof b === "string") b = (new TextEncoder).encode(b); else if (b && !(b instanceof Uint8Array)) b = (new TextEncoder).encode(JSON.stringify(b));
  b = b || new Uint8Array(0);
  let h = "";
  const hs = Object.assign({
    "Content-Length": String(b.length)
  }, r.headers || {});
  for (const k in hs) h += k + ": " + hs[k] + "\r\n";
  n.last = {
    h: (new TextEncoder).encode(h),
    b
  };
  (growMemViews(), HEAP32)[status / 4 >>> 0] = r.status || 200;
  (growMemViews(), HEAP32)[hlen / 4 >>> 0] = n.last.h.length;
  return b.length;
}

function _inet_take(headers, body) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(35, 0, 1, headers, body);
  headers >>>= 0;
  body >>>= 0;
  const l = Module.uewNet.last;
  (growMemViews(), HEAPU8).set(l.h, headers >>> 0);
  (growMemViews(), HEAPU8).set(l.b, body >>> 0);
  Module.uewNet.last = null;
}

function _js_audio_open(rate) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(36, 0, 1, rate);
  if (Module.uewAudio) return 1;
  if (typeof AudioContext === "undefined" || !globalThis.AudioWorkletNode) return 0;
  const A = Module.uewAudio = {
    ctx: new AudioContext({
      sampleRate: rate,
      latencyHint: "interactive"
    }),
    node: null,
    pushed: 0,
    start: -1,
    rate,
    pending: []
  };
  const code = `class P extends AudioWorkletProcessor {\n        constructor() { super(); this.q = []; this.off = 0; this.port.onmessage = (e) => this.q.push(e.data); }\n        process(inp, out) {\n            const L = out[0][0], R = out[0][1] || out[0][0];\n            for (let i = 0; i < L.length; i++) {\n                while (this.q.length && this.off >= this.q[0].length) { this.q.shift(); this.off = 0; }\n                if (!this.q.length) { L[i] = 0; R[i] = 0; continue; }\n                const b = this.q[0]; L[i] = b[this.off]; R[i] = b[this.off + 1]; this.off += 2;\n            }\n            return true;\n        } }\n        registerProcessor("uew-out", P);`;
  const url = URL.createObjectURL(new Blob([ code ], {
    type: "text/javascript"
  }));
  A.ctx.audioWorklet.addModule(url).then(() => {
    A.node = new AudioWorkletNode(A.ctx, "uew-out", {
      outputChannelCount: [ 2 ]
    });
    A.node.connect(A.ctx.destination);
    for (const b of A.pending) A.node.port.postMessage(b, [ b.buffer ]);
    A.pending = [];
  });
  const resume = () => {
    if (A.ctx.state !== "running") A.ctx.resume();
  };
  for (const ev of [ "keydown", "mousedown", "touchstart", "pointerdown" ]) window.addEventListener(ev, resume, {
    capture: true
  });
  return 1;
}

function _js_audio_queued() {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(37, 0, 1);
  const A = Module.uewAudio;
  if (!A) return 0;
  // until the page may play sound, time still passes (games wait for sounds to end) and samples are dropped
  const live = A.ctx.state === "running" && !!A.node;
  const now = live ? A.ctx.currentTime : performance.now() / 1e3;
  if (A.live !== live || A.start < 0) {
    A.live = live;
    A.start = now;
    A.pushed = 0;
  }
  const played = (now - A.start) * A.rate;
  // the worklet ran dry: start counting again from now
  if (A.pushed < played) {
    A.start = now;
    A.pushed = 0;
    return 0;
  }
  return Math.round(A.pushed - played);
}

function _js_audio_restart() {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(38, 0, 1);
  const A = Module.uewAudio;
  if (A) A.start = -1;
}

function _js_audio_write(frames, count) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(39, 0, 1, frames, count);
  frames >>>= 0;
  const A = Module.uewAudio;
  if (!A) return;
  const src = (growMemViews(), HEAPF32).subarray(frames / 4 >>> 0, frames / 4 + count * 2 >>> 0);
  // loudest recent sample (every 8th), for tests that check sound is really produced
  for (let i = 0; i < src.length; i += 8) {
    const v = Math.abs(src[i]);
    if (v > (A.peak || 0)) A.peak = v;
  }
  if (!A.live) {
    A.pushed += count;
    return;
  }
  const b = new Float32Array(count * 2);
  b.set(src);
  A.pushed += count;
  if (A.node) A.node.port.postMessage(b, [ b.buffer ]); else if (A.pending.length < 64) A.pending.push(b);
}

function _net_avail(id) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(40, 0, 1, id);
  const c = Module.uewNet && Module.uewNet.conns ? Module.uewNet.conns[id] : null;
  if (!c) return -1;
  return c.qlen ? c.qlen : c.closed ? -1 : 0;
}

var _net_claim = function(name) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(41, 0, 1, name);
  name >>>= 0;
  const n = Module.uewNet;
  if (!n) return 0;
  const s = UTF8ToString(name);
  const wisp = !(n.claim && n.claim(s));
  if (wisp && !(n.wisp && n.wisp.ok(s))) return 0;
  n.names = n.names || [ null ];
  let i = n.names.findIndex(r => r && r.name === s && r.wisp === wisp);
  if (i < 0) {
    i = n.names.length;
    n.names.push({
      name: s,
      wisp
    });
  }
  return i;
};

var _net_claim_ip = function(ip) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(42, 0, 1, ip);
  ip >>>= 0;
  const n = Module.uewNet;
  const s = UTF8ToString(ip);
  if (!n || !n.wisp || !n.wisp.ok(s)) return 0;
  n.names = n.names || [ null ];
  let i = n.names.findIndex(r => r && r.name === s && r.wisp);
  if (i < 0) {
    i = n.names.length;
    n.names.push({
      name: s,
      wisp: true
    });
  }
  return i;
};

function _net_close(id) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(43, 0, 1, id);
  const c = Module.uewNet && Module.uewNet.conns ? Module.uewNet.conns[id] : null;
  if (c) {
    if (c.close) c.close();
    Module.uewNet.conns[id] = null;
  }
}

var _net_open = function(route, port, udp) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(44, 0, 1, route, port, udp);
  const n = Module.uewNet;
  const r = n && n.names ? n.names[route] : null;
  if (!r) return 0;
  const c = r.wisp ? n.wisp.open(r.name, port, !!udp) : n.open ? n.open(r.name, port) : null;
  if (!c) return 0;
  n.conns = n.conns || [ null ];
  const id = n.conns.length;
  c.q = [];
  c.qlen = 0;
  c.closed = false;
  c.push = data => {
    if (data && data.length) {
      c.q.push(data);
      c.qlen += data.length;
    }
  };
  c.end = () => {
    c.closed = true;
  };
  n.conns.push(c);
  return id;
};

function _net_recv(id, p, cap) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(45, 0, 1, id, p, cap);
  p >>>= 0;
  const c = Module.uewNet.conns[id];
  if (!c) return -1;
  if (!c.qlen) return c.closed ? -1 : 0;
  let n = 0;
  while (n < cap && c.q.length) {
    const d = c.q[0], k = Math.min(cap - n, d.length);
    (growMemViews(), HEAPU8).set(d.subarray(0, k), p + n >>> 0);
    n += k;
    if (k == d.length) c.q.shift(); else c.q[0] = d.subarray(k);
  }
  c.qlen -= n;
  return n;
}

function _net_recv1(id, p, cap) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(46, 0, 1, id, p, cap);
  p >>>= 0;
  const c = Module.uewNet.conns[id];
  if (!c) return -1;
  if (!c.q.length) return c.closed ? -1 : 0;
  const d = c.q.shift();
  c.qlen -= d.length;
  const k = Math.min(cap, d.length);
  (growMemViews(), HEAPU8).set(d.subarray(0, k), p >>> 0);
  return k;
}

function _net_send(id, p, n) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(47, 0, 1, id, p, n);
  p >>>= 0;
  const c = Module.uewNet.conns[id];
  if (c && c.send) c.send((growMemViews(), HEAPU8).slice(p, p + n));
}

function _random_get(buffer, size) {
  buffer >>>= 0;
  size >>>= 0;
  return randomFill((growMemViews(), HEAPU8).subarray(buffer >>> 0, buffer + size >>> 0));
}

var uewSCM = {
  s: null,
  PROTOCOL: 65581,
  EMSG: {
    Multi: 1,
    ClientHeartBeat: 703,
    ClientLogOnResponse: 751,
    ClientLoggedOff: 757,
    ClientAccountInfo: 768,
    ClientGameConnectTokens: 779,
    ClientCMList: 783,
    ClientGetAppOwnershipTicket: 857,
    ClientGetAppOwnershipTicketResponse: 858,
    ClientAuthList: 5432,
    ClientAuthListAck: 5575,
    ClientGamesPlayed: 742,
    ClientLogon: 5514,
    ClientRequestEncryptedAppTicket: 5526,
    ClientRequestEncryptedAppTicketResponse: 5527,
    ServiceMethodCallFromClientNonAuthed: 9804,
    ServiceMethodResponse: 147,
    ClientHello: 9805
  },
  CMS: [ "cmp1-ord1.steamserver.net:443", "cmp2-ord1.steamserver.net:443", "cmp1-iad1.steamserver.net:443", "cmp1-sea1.steamserver.net:443", "cmp1-lax1.steamserver.net:443", "cmp1-fra1.steamserver.net:443", "cmp1-ams1.steamserver.net:443", "cmp1-sto3.steamserver.net:443" ],
  pb: {
    varint(out, v) {
      v = BigInt.asUintN(64, BigInt(v));
      while (v >= 128n) {
        out.push(Number(v & 127n) | 128);
        v >>= 7n;
      }
      out.push(Number(v));
    },
    enc(fields) {
      const out = [], te = new TextEncoder;
      for (const [n, k, v] of fields) {
        if (v === undefined || v === null) continue;
        if (k === "v" || k === "b") {
          this.varint(out, n << 3);
          this.varint(out, k === "b" ? (v ? 1 : 0) : v);
        } else if (k === "q") {
          this.varint(out, n << 3 | 1);
          let x = BigInt.asUintN(64, BigInt(v));
          for (let i = 0; i < 8; i++) {
            out.push(Number(x & 255n));
            x >>= 8n;
          }
        } else {
          const b = k === "s" ? te.encode(v) : v;
          this.varint(out, n << 3 | 2);
          this.varint(out, b.length);
          for (let i = 0; i < b.length; i++) out.push(b[i]);
        }
      }
      return Uint8Array.from(out);
    },
    dec(b) {
      const m = new Map;
      let p = 0;
      const rv = () => {
        let r = 0n, s = 0n, c;
        do {
          c = b[p++];
          r |= BigInt(c & 127) << s;
          s += 7n;
        } while (c & 128);
        return r;
      };
      while (p < b.length) {
        const key = Number(rv()), n = key >>> 3, wt = key & 7;
        let v;
        if (wt === 0) v = rv(); else if (wt === 1) {
          v = 0n;
          for (let i = 7; i >= 0; i--) v = v << 8n | BigInt(b[p + i]);
          p += 8;
        } else if (wt === 2) {
          const l = Number(rv());
          v = b.subarray(p, p + l);
          p += l;
        } else if (wt === 5) {
          v = b[p] | b[p + 1] << 8 | b[p + 2] << 16 | b[p + 3] << 24;
          p += 4;
        } else break;
        if (!m.has(n)) m.set(n, []);
        m.get(n).push(v);
      }
      return m;
    },
    str(m, n) {
      const v = m.get(n);
      return v ? (new TextDecoder).decode(v[0]) : "";
    },
    num(m, n, d = 0) {
      const v = m.get(n);
      return v ? Number(BigInt.asIntN(64, BigInt(v[0]))) : d;
    },
    big(m, n) {
      const v = m.get(n);
      return v ? BigInt(v[0]) : 0n;
    },
    bytes(m, n) {
      const v = m.get(n);
      return v ? v[0] : new Uint8Array(0);
    },
    all(m, n) {
      return m.get(n) || [];
    }
  },
  get() {
    if (this.s) return this.s;
    this.s = {
      state: 0,
      ws: null,
      steamid: 0n,
      session: 0,
      jobs: new Map,
      nextJob: 1n,
      tokens: [],
      tickets: [],
      acks: new Map,
      acked: new Set,
      owner: new Map,
      name: "",
      appid: 0,
      reqs: new Map,
      nextReq: 1,
      seq: 0,
      heartbeat: 0
    };
    return this.s;
  },
  log(t) {
    console.log("[steam] " + t);
  },
  connect() {
    const W = Module.uewNet && Module.uewNet.wisp, q = new URLSearchParams(location.search);
    const via = W && (q.has("steamwisp") ? q.get("steamwisp") !== "0" : !!(Module.uewWisp && Module.uewWisp.steam));
    return via ? this.connectTcp(W) : this.connectWs();
  },
  connectWs() {
    const s = this.get();
    let list = [];
    try {
      list = JSON.parse(localStorage.getItem("uew_steam_cms") || "[]");
    } catch (e) {}
    const q = new URLSearchParams(location.search).get("steamcm");
    const hosts = [ ...new Set([ ...(q ? [ q ] : []), ...list, ...this.CMS ]) ];
    return new Promise((resolve, reject) => {
      const tryNext = i => {
        if (i >= hosts.length) {
          reject(new Error("can't reach Steam's servers"));
          return;
        }
        const ws = new WebSocket("wss://" + hosts[i] + "/cmsocket/");
        ws.binaryType = "arraybuffer";
        const t = setTimeout(() => {
          ws.onopen = ws.onerror = null;
          ws.close();
          tryNext(i + 1);
        }, 6e3);
        ws.onopen = () => {
          clearTimeout(t);
          s.ws = ws;
          ws.onmessage = e => this.onPacket(new Uint8Array(e.data));
          ws.onclose = () => {
            if (s.ws === ws) {
              s.ws = null;
              if (s.state === 1) {
                this.log("disconnected from Steam");
                s.state = -1;
              }
            }
          };
          this.send(this.EMSG.ClientHello, this.pb.enc([ [ 1, "v", this.PROTOCOL ] ]));
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(t);
          ws.onopen = ws.onerror = null;
          tryNext(i + 1);
        };
      };
      tryNext(0);
    });
  },
  UNIVERSE_KEY: "30819d300d06092a864886f70d010101050003818b0030818702818100dfec1ad62c10662c17353a14b07c59117f9dd3d82b7ae3e015cd191e46e87b8774a2184631a9031479828ee945a24912a923687389cf69a1b16146bdc1bebfd6011bd881d4dc90fbfe4f527366cb9570d7c58eba1c7a3375a1623446bb60b78068fa13a77a8a374b9ec6f45d5f3a99f99ec43ae963a2bb881928e0e714c04289020111",
  TCP_CMS: [ "ext1-ord1.steamserver.net:27017", "ext1-iad1.steamserver.net:27017", "ext1-sea1.steamserver.net:27017", "ext1-fra1.steamserver.net:27017" ],
  connectTcp(W) {
    const s = this.get(), sub = crypto.subtle;
    let list = [];
    try {
      list = JSON.parse(localStorage.getItem("uew_steam_cms_tcp") || "[]");
    } catch (e) {}
    const hosts = [ ...new Set([ ...list, ...this.TCP_CMS ]) ];
    const hex = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));
    const cat = (...a) => {
      const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
      let p = 0;
      for (const x of a) {
        o.set(x, p);
        p += x.length;
      }
      return o;
    };
    const crc32 = b => {
      let c = ~0;
      for (const x of b) {
        c ^= x;
        for (let k = 0; k < 8; k++) c = c >>> 1 ^ (3988292384 & -(c & 1));
      }
      return ~c >>> 0;
    };
    const zero = new Uint8Array(16), pad = new Uint8Array(16).fill(16);
    return new Promise((resolve, reject) => {
      const tryNext = i => {
        if (i >= hosts.length) {
          reject(new Error("can't reach Steam's servers through WISP"));
          return;
        }
        const [host, port] = hosts[i].split(":");
        const c = W.open(host, +port || 27017, false);
        let inbuf = new Uint8Array(0), stage = 0, aes = null, hmac = null, inq = Promise.resolve(), outq = Promise.resolve();
        const fail = why => {
          if (stage < 3) {
            stage = 9;
            clearTimeout(t);
            c.close();
            this.log(hosts[i] + ": " + why);
            tryNext(i + 1);
          }
        };
        const t = setTimeout(() => fail("no answer"), 8e3);
        const frame = d => {
          const f = new Uint8Array(8 + d.length), v = new DataView(f.buffer);
          v.setUint32(0, d.length, true);
          v.setUint32(4, 825250902, true);
          f.set(d, 8);
          c.send(f);
        };
        // one AES block without chaining, from WebCrypto's CBC (which has no ECB): encrypting with a zero IV, and
        // decrypting with a second block made so the padding check passes
        const ecbEnc = async b => new Uint8Array(await sub.encrypt({
          name: "AES-CBC",
          iv: zero
        }, aes, b)).subarray(0, 16);
        const ecbDec = async b => {
          const x = new Uint8Array(16);
          for (let k = 0; k < 16; k++) x[k] = b[k] ^ pad[k];
          return new Uint8Array(await sub.decrypt({
            name: "AES-CBC",
            iv: zero
          }, aes, cat(b, await ecbEnc(x))));
        };
        const seal = async plain => {
          const iv = new Uint8Array(16);
          crypto.getRandomValues(iv.subarray(13));
          iv.set(new Uint8Array(await sub.sign("HMAC", hmac, cat(iv.subarray(13), plain))).subarray(0, 13));
          return cat(await ecbEnc(iv), new Uint8Array(await sub.encrypt({
            name: "AES-CBC",
            iv
          }, aes, plain)));
        };
        const open = async d => {
          const iv = await ecbDec(d.subarray(0, 16));
          const plain = new Uint8Array(await sub.decrypt({
            name: "AES-CBC",
            iv
          }, aes, d.subarray(16)));
          const h = new Uint8Array(await sub.sign("HMAC", hmac, cat(iv.subarray(13), plain)));
          for (let k = 0; k < 13; k++) if (h[k] !== iv[k]) throw new Error("bad HMAC");
          return plain;
        };
        const handshake = async d => {
          const v = new DataView(d.buffer, d.byteOffset, d.byteLength), emsg = v.getUint32(0, true);
          if (stage === 0 && emsg === 1303) {
            // ChannelEncryptRequest: protocol, universe, challenge
            const key = crypto.getRandomValues(new Uint8Array(32));
            const rsa = await sub.importKey("spki", hex(this.UNIVERSE_KEY), {
              name: "RSA-OAEP",
              hash: "SHA-1"
            }, false, [ "encrypt" ]);
            const blob = new Uint8Array(await sub.encrypt({
              name: "RSA-OAEP"
            }, rsa, cat(key, d.subarray(28))));
            aes = await sub.importKey("raw", key, "AES-CBC", false, [ "encrypt", "decrypt" ]);
            hmac = await sub.importKey("raw", key.subarray(0, 16), {
              name: "HMAC",
              hash: "SHA-1"
            }, false, [ "sign" ]);
            const r = new Uint8Array(20 + 8 + blob.length + 8), rv = new DataView(r.buffer);
            rv.setUint32(0, 1304, true);
            rv.setBigUint64(4, 18446744073709551615n, true);
            rv.setBigUint64(12, 18446744073709551615n, true);
            rv.setUint32(20, 1, true);
            rv.setUint32(24, 128, true);
            r.set(blob, 28);
            rv.setUint32(28 + blob.length, crc32(blob), true);
            stage = 1;
            frame(r);
          } else if (stage === 1 && emsg === 1305) {
            // ChannelEncryptResult
            const er = v.getUint32(20, true);
            if (er !== 1) {
              fail("channel encryption refused (" + er + ")");
              return;
            }
            stage = 3;
            clearTimeout(t);
            s.ws = {
              send: p => {
                outq = outq.then(async () => frame(await seal(p))).catch(() => {});
              }
            };
            c.end = () => {
              if (s.ws && s.ws.c === c) {
                s.ws = null;
                if (s.state === 1) {
                  this.log("disconnected from Steam");
                  s.state = -1;
                }
              }
            };
            s.ws.c = c;
            this.log("connected to Steam through WISP (" + hosts[i] + ")");
            this.send(this.EMSG.ClientHello, this.pb.enc([ [ 1, "v", this.PROTOCOL ] ]));
            resolve();
          }
        };
        c.end = () => fail("closed");
        c.push = data => {
          inbuf = cat(inbuf, data);
          while (inbuf.length >= 8) {
            const v = new DataView(inbuf.buffer, inbuf.byteOffset), n = v.getUint32(0, true);
            if (v.getUint32(4, true) !== 825250902) {
              fail("not a Steam server");
              return;
            }
            if (inbuf.length < 8 + n) break;
            const d = inbuf.slice(8, 8 + n);
            inbuf = inbuf.slice(8 + n);
            if (stage < 3) inq = inq.then(() => handshake(d)).catch(e => fail(e.message)); else inq = inq.then(async () => this.onPacket(await open(d))).catch(e => this.log("Steam packet: " + e.message));
          }
        };
      };
      tryNext(0);
    });
  },
  send(emsg, body, hdr = []) {
    const s = this.get();
    const h = this.pb.enc([ [ 1, "q", s.steamid || 76561197960265728n ], [ 2, "v", s.session ], ...hdr ]);
    const p = new Uint8Array(8 + h.length + body.length);
    const dv = new DataView(p.buffer);
    dv.setUint32(0, (emsg | 2147483648) >>> 0, true);
    dv.setUint32(4, h.length, true);
    p.set(h, 8);
    p.set(body, 8 + h.length);
    if (s.ws) s.ws.send(p);
  },
  job(emsg, body, hdr = []) {
    const s = this.get();
    const id = s.nextJob++;
    return new Promise((resolve, reject) => {
      s.jobs.set(id, {
        resolve,
        t: setTimeout(() => {
          s.jobs.delete(id);
          reject(new Error("Steam did not answer"));
        }, 2e4)
      });
      this.send(emsg, body, [ [ 10, "q", id ], ...hdr ]);
    });
  },
  async service(method, body) {
    const r = await this.job(this.EMSG.ServiceMethodCallFromClientNonAuthed, body, [ [ 12, "s", method ] ]);
    const er = this.pb.num(r.hdr, 13, 2);
    const known = {
      5: "Wrong account name or password",
      65: "That Steam Guard code is wrong",
      84: "Too many sign-in attempts: wait a while and try again",
      88: "That Steam Guard code is wrong",
      18: "No Steam account by that name"
    };
    if (er !== 1) throw new Error(known[er] || this.pb.str(r.hdr, 14) || "Steam error " + er);
    return r.body;
  },
  async onPacket(p) {
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const raw = dv.getUint32(0, true), emsg = raw & 2147483647;
    if (!(raw & 2147483648)) return;
    // every message a client gets on a WebSocket CM is protobuf
    const hl = dv.getUint32(4, true);
    const hdr = this.pb.dec(p.subarray(8, 8 + hl)), body = p.subarray(8 + hl);
    if (emsg === this.EMSG.Multi) {
      await this.onMulti(this.pb.dec(body));
      return;
    }
    this.onMessage(emsg, hdr, body);
  },
  async onMulti(m) {
    let b = this.pb.bytes(m, 2);
    if (this.pb.num(m, 1)) b = new Uint8Array(await new Response(new Blob([ b ]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    for (let o = 0; o + 4 <= b.length; ) {
      const n = b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24;
      await this.onPacket(b.slice(o + 4, o + 4 + n));
      o += 4 + n;
    }
  },
  onMessage(emsg, hdr, body) {
    const s = this.get(), E = this.EMSG, pb = this.pb;
    const target = pb.big(hdr, 11);
    if (target && s.jobs.has(target)) {
      const j = s.jobs.get(target);
      s.jobs.delete(target);
      clearTimeout(j.t);
      j.resolve({
        emsg,
        hdr,
        body: pb.dec(body)
      });
      return;
    }
    const m = pb.dec(body);
    switch (emsg) {
     case E.ClientLogOnResponse:
      {
        const er = pb.num(m, 1, 2);
        if (s.onLogon) s.onLogon(er, hdr, m);
        break;
      }

     case E.ClientLoggedOff:
      this.log("signed out by Steam (result " + pb.num(m, 1) + ")");
      s.state = -1;
      break;

     case E.ClientAccountInfo:
      s.name = pb.str(m, 1) || s.name;
      break;

     case E.ClientGameConnectTokens:
      {
        for (const t of pb.all(m, 2)) s.tokens.push(t.slice());
        const keep = pb.num(m, 1, 10);
        while (s.tokens.length > keep) s.tokens.shift();
        break;
      }

     case E.ClientCMList:
      {
        const ws = pb.all(m, 6).map(v => (new TextDecoder).decode(v)).filter(Boolean);
        if (ws.length) try {
          localStorage.setItem("uew_steam_cms", JSON.stringify(ws.slice(0, 12)));
        } catch (e) {}
        // TCP CMs: IPv4 addresses (host order) and ports, each list plain or packed
        const nums = n => pb.all(m, n).flatMap(v => {
          if (!(v instanceof Uint8Array)) return [ Number(v) ];
          const o = [];
          let p = 0;
          while (p < v.length) {
            let r = 0, sh = 0, c;
            do {
              c = v[p++];
              r += (c & 127) * 2 ** sh;
              sh += 7;
            } while (c & 128);
            o.push(r);
          }
          return o;
        });
        const ips = nums(1), ports = nums(2);
        const tcp = ips.map((a, i) => `${a >>> 24}.${a >>> 16 & 255}.${a >>> 8 & 255}.${a & 255}:${ports[i] || 27017}`);
        if (tcp.length) try {
          localStorage.setItem("uew_steam_cms_tcp", JSON.stringify(tcp.slice(0, 12)));
        } catch (e) {}
        break;
      }

     case E.ClientAuthListAck:
      for (const c of pb.all(m, 1)) {
        const w = s.acks.get(Number(c));
        if (w) w();
        s.acked.add(Number(c));
      }
      break;
    }
  },
  rsa(modHex, expHex, text) {
    const n = BigInt("0x" + modHex), e = BigInt("0x" + expHex);
    const k = modHex.length / 2, msg = (new TextEncoder).encode(text);
    const em = new Uint8Array(k);
    em[1] = 2;
    const ps = k - 3 - msg.length;
    const rnd = crypto.getRandomValues(new Uint8Array(ps));
    for (let i = 0; i < ps; i++) em[2 + i] = rnd[i] || 1;
    em.set(msg, k - msg.length);
    let m = 0n;
    for (const b of em) m = m << 8n | BigInt(b);
    let r = 1n, base = m % n, x = e;
    while (x > 0n) {
      if (x & 1n) r = r * base % n;
      base = base * base % n;
      x >>= 1n;
    }
    const out = new Uint8Array(k);
    for (let i = k - 1; i >= 0; i--) {
      out[i] = Number(r & 255n);
      r >>= 8n;
    }
    return btoa(String.fromCharCode(...out));
  },
  device() {
    return this.pb.enc([ [ 1, "s", "UEWASM (browser)" ], [ 2, "v", 1 ], [ 3, "v", 20 ] ]);
  },
  async signInWithPassword(account, password, ui) {
    const pb = this.pb;
    const key = await this.service("Authentication.GetPasswordRSAPublicKey#1", pb.enc([ [ 1, "s", account ] ]));
    const enc = this.rsa(pb.str(key, 1), pb.str(key, 2), password);
    const r = await this.service("Authentication.BeginAuthSessionViaCredentials#1", pb.enc([ [ 1, "s", "UEWASM (browser)" ], [ 2, "s", account ], [ 3, "s", enc ], [ 4, "v", pb.big(key, 3) ], [ 5, "b", true ], [ 6, "v", 1 ], [ 7, "v", 1 ], [ 8, "s", "Client" ], [ 9, "m", this.device() ] ]));
    const client = pb.big(r, 1), request = pb.bytes(r, 2), steamid = pb.big(r, 5), interval = 2e3;
    const kinds = pb.all(r, 4).map(c => pb.num(pb.dec(c), 1));
    // 2 email code, 3 authenticator code, 4 approve in the mobile app, 5 email link
    const codeKind = kinds.includes(3) ? 3 : kinds.includes(2) ? 2 : 0;
    ui.guard(kinds, codeKind ? async code => {
      await this.service("Authentication.UpdateAuthSessionWithSteamGuardCode#1", pb.enc([ [ 1, "v", client ], [ 2, "q", steamid ], [ 3, "s", code ], [ 4, "v", codeKind ] ]));
    } : null);
    for (let tries = 0; tries < 300; tries++) {
      await new Promise(res => setTimeout(res, interval));
      const p = await this.service("Authentication.PollAuthSessionStatus#1", pb.enc([ [ 1, "v", client ], [ 2, "y", request ] ]));
      const refresh = pb.str(p, 3);
      if (refresh) return {
        account: pb.str(p, 6) || account,
        refresh
      };
    }
    throw new Error("sign-in timed out");
  },
  async signInWithQR(ui, stop) {
    const pb = this.pb, sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let sessions = 0; !stop.done && sessions < 20; sessions++) {
      let r;
      try {
        r = await this.service("Authentication.BeginAuthSessionViaQR#1", pb.enc([ [ 1, "s", "UEWASM (browser)" ], [ 2, "v", 1 ], [ 3, "m", this.device() ], [ 4, "s", "Client" ] ]));
      } catch (e) {
        ui.qrSay("QR sign-in isn't available: " + e.message);
        return null;
      }
      let client = pb.big(r, 1);
      const request = pb.bytes(r, 3), iv = r.get(4) ? new Float32Array(Int32Array.of(r.get(4)[0]).buffer)[0] : 0;
      ui.qr(pb.str(r, 2));
      ui.qrSay("Scan with the Steam Mobile App");
      for (;;) {
        await sleep(iv > 0 ? iv * 1e3 : 5e3);
        if (stop.done) return null;
        let p;
        try {
          p = await this.service("Authentication.PollAuthSessionStatus#1", pb.enc([ [ 1, "v", client ], [ 2, "y", request ] ]));
        } catch (e) {
          break;
        }
        // the code expired: start a new one
        if (pb.big(p, 1)) client = pb.big(p, 1);
        if (pb.str(p, 2)) ui.qr(pb.str(p, 2));
        if (pb.num(p, 5)) ui.qrSay("Approve the sign-in on your phone");
        const refresh = pb.str(p, 3);
        if (refresh) return {
          account: pb.str(p, 6),
          refresh
        };
      }
    }
    return null;
  },
  qrCode(text) {
    const data = Array.from((new TextEncoder).encode(text));
    const ECC = [ 0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26 ], BLOCKS = [ 0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5 ];
    const raw = v => {
      let r = (16 * v + 128) * v + 64;
      if (v >= 2) {
        const a = Math.floor(v / 7) + 2;
        r -= (25 * a - 10) * a - 55;
        if (v >= 7) r -= 36;
      }
      return r;
    };
    const cap = v => Math.floor(raw(v) / 8) - ECC[v] * BLOCKS[v];
    let ver = 1;
    while (ver <= 10 && 4 + (ver < 10 ? 8 : 16) + 8 * data.length > cap(ver) * 8) ver++;
    if (ver > 10) throw new Error("QR text too long");
    // bits: byte mode, length, data, terminator, padding
    const bits = [], put = (v, n) => {
      for (let i = n - 1; i >= 0; i--) bits.push(v >>> i & 1);
    };
    put(4, 4);
    put(data.length, ver < 10 ? 8 : 16);
    for (const b of data) put(b, 8);
    const cw = cap(ver);
    put(0, Math.min(4, cw * 8 - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (let pad = 236; bits.length < cw * 8; pad ^= 236 ^ 17) put(pad, 8);
    const bytes = [];
    for (let i = 0; i < bits.length; i += 8) bytes.push(bits.slice(i, i + 8).reduce((a, b) => a << 1 | b, 0));
    // Reed-Solomon over GF(256), split into blocks and interleaved
    const mul = (x, y) => {
      let z = 0;
      for (let i = 7; i >= 0; i--) {
        z = z << 1 ^ (z >>> 7) * 285;
        z ^= (y >>> i & 1) * x;
      }
      return z;
    };
    const deg = ECC[ver], div = new Array(deg).fill(0);
    div[deg - 1] = 1;
    for (let i = 0, root = 1; i < deg; i++, root = mul(root, 2)) for (let j = 0; j < deg; j++) {
      div[j] = mul(div[j], root);
      if (j + 1 < deg) div[j] ^= div[j + 1];
    }
    const rem = d => {
      const r = new Array(deg).fill(0);
      for (const b of d) {
        const f = b ^ r.shift();
        r.push(0);
        for (let i = 0; i < deg; i++) r[i] ^= mul(div[i], f);
      }
      return r;
    };
    const nb = BLOCKS[ver], total = Math.floor(raw(ver) / 8), nshort = nb - total % nb, slen = Math.floor(total / nb);
    const blocks = [];
    for (let i = 0, k = 0; i < nb; i++) {
      const d = bytes.slice(k, k + slen - deg + (i < nshort ? 0 : 1));
      k += d.length;
      const e = rem(d);
      if (i < nshort) d.push(0);
      blocks.push(d.concat(e));
    }
    const words = [];
    for (let i = 0; i < blocks[0].length; i++) for (let j = 0; j < nb; j++) if (i !== slen - deg || j >= nshort) words.push(blocks[j][i]);
    // function patterns
    const n = ver * 4 + 17, mod = new Uint8Array(n * n), fn = new Uint8Array(n * n);
    const set = (x, y, d) => {
      mod[y * n + x] = d ? 1 : 0;
      fn[y * n + x] = 1;
    };
    for (let i = 0; i < n; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [ [ 3, 3 ], [ n - 4, 3 ], [ 3, n - 4 ] ]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < n && y >= 0 && y < n) set(x, y, d !== 2 && d !== 4);
    }
    if (ver > 1) {
      const na = Math.floor(ver / 7) + 2, step = Math.ceil((ver * 4 + 4) / (na * 2 - 2)) * 2, pos = [ 6 ];
      for (let p = n - 7; pos.length < na; p -= step) pos.splice(1, 0, p);
      for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    const format = mask => {
      const d = mask;
      // level M is 00
      let r = d;
      for (let i = 0; i < 10; i++) r = r << 1 ^ (r >>> 9) * 1335;
      const b = (d << 10 | r) ^ 21522, bit = i => (b >>> i & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6));
      set(8, 8, bit(7));
      set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(n - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, n - 15 + i, bit(i));
      set(8, n - 8, true);
    };
    format(0);
    if (ver >= 7) {
      let r = ver;
      for (let i = 0; i < 12; i++) r = r << 1 ^ (r >>> 11) * 7973;
      const b = ver << 12 | r;
      for (let i = 0; i < 18; i++) {
        const d = (b >>> i & 1) === 1, a = n - 11 + i % 3, c = Math.floor(i / 3);
        set(a, c, d);
        set(c, a, d);
      }
    }
    // data, in the zigzag column pairs
    for (let right = n - 1, i = 0; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let v = 0; v < n; v++) for (let j = 0; j < 2; j++) {
        const x = right - j, y = (right + 1 & 2) === 0 ? n - 1 - v : v;
        if (!fn[y * n + x] && i < words.length * 8) {
          mod[y * n + x] = words[i >>> 3] >>> 7 - (i & 7) & 1;
          i++;
        }
      }
    }
    // the mask with the lowest penalty
    const masks = [ (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0, (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0 ];
    const apply = k => {
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!fn[y * n + x] && masks[k](x, y)) mod[y * n + x] ^= 1;
    };
    const penalty = () => {
      let p = 0, dark = 0;
      const at = (x, y) => x >= 0 && x < n && y >= 0 && y < n ? mod[y * n + x] : 0;
      for (let pass = 0; pass < 2; pass++) for (let a = 0; a < n; a++) {
        let run = 1;
        for (let b = 1; b <= n; b++) {
          const cur = b < n ? (pass ? at(a, b) : at(b, a)) : -1, prev = pass ? at(a, b - 1) : at(b - 1, a);
          if (cur === prev) run++; else {
            if (run >= 5) p += run - 2;
            run = 1;
          }
        }
        for (let b = -4; b < n; b++) {
          // finder-like 1:1:3:1:1 with 4 light modules on one side
          const g = k => pass ? at(a, b + k) : at(b + k, a);
          const core = g(4) && !g(5) && g(6) && g(7) && g(8) && !g(9) && g(10);
          if (core && ((!g(0) && !g(1) && !g(2) && !g(3)) || (!g(11) && !g(12) && !g(13) && !g(14)))) p += 40;
        }
      }
      for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
        const c = mod[y * n + x];
        if (c === mod[y * n + x + 1] && c === mod[(y + 1) * n + x] && c === mod[(y + 1) * n + x + 1]) p += 3;
      }
      for (const c of mod) dark += c;
      return p + Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
    };
    let best = 0, bestP = Infinity;
    for (let k = 0; k < 8; k++) {
      apply(k);
      format(k);
      const q = penalty();
      if (q < bestP) {
        bestP = q;
        best = k;
      }
      apply(k);
    }
    apply(best);
    format(best);
    return {
      n,
      dark: (x, y) => mod[y * n + x] === 1
    };
  },
  machineId() {
    // binary KeyValues: MessageObject { BB3, FF2, 3B3 } hex strings, stable for this browser
    let key = "uewasm";
    try {
      key = localStorage.getItem("uew_webworks_device") || key;
    } catch (e) {}
    const hex = s => Array.from((new TextEncoder).encode(s)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 40).padEnd(40, "0");
    const parts = [ 0, ...(new TextEncoder).encode("MessageObject"), 0 ];
    for (const [k, v] of [ [ "BB3", hex(key + "b") ], [ "FF2", hex(key + "f") ], [ "3B3", hex(key + "3") ] ]) parts.push(1, ...(new TextEncoder).encode(k), 0, ...(new TextEncoder).encode(v), 0);
    parts.push(8, 8);
    return Uint8Array.from(parts);
  },
  logon(account, refresh) {
    const s = this.get(), pb = this.pb;
    return new Promise((resolve, reject) => {
      s.onLogon = (er, hdr, m) => {
        s.onLogon = null;
        if (er !== 1) {
          reject(new Error("Steam refused the sign-in (result " + er + ")"));
          return;
        }
        s.steamid = pb.big(hdr, 1);
        s.session = pb.num(hdr, 2);
        const beat = pb.num(m, 3, 9);
        clearInterval(s.heartbeat);
        s.heartbeat = setInterval(() => this.send(this.EMSG.ClientHeartBeat, pb.enc([ [ 1, "b", false ] ])), beat * 1e3);
        resolve();
      };
      this.send(this.EMSG.ClientLogon, pb.enc([ [ 1, "v", this.PROTOCOL ], [ 3, "v", 0 ], [ 5, "v", 1771 ], [ 6, "s", "english" ], [ 7, "v", 20 ], [ 8, "b", true ], [ 30, "y", this.machineId() ], [ 50, "s", account ], [ 96, "s", "UEWASM (browser)" ], [ 102, "b", true ], [ 108, "s", refresh ] ]));
      setTimeout(() => {
        if (s.onLogon) {
          s.onLogon = null;
          reject(new Error("Steam did not answer the sign-in"));
        }
      }, 2e4);
    });
  },
  dialog() {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:#000b;font:14px system-ui,sans-serif;color:#dfe3e6";
    box.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start;background:#1b2838;padding:22px 24px;border-radius:8px;max-width:calc(100vw - 32px);box-sizing:border-box;box-shadow:0 8px 32px #000a">\n        <form style="width:300px;max-width:100%">\n        <div style="font-size:18px;font-weight:600;margin-bottom:4px">Sign in to Steam</div>\n        <div style="font-size:12px;color:#8f98a0;margin-bottom:14px">This game uses your Steam account. Your password goes only to Steam.</div>\n        <input name="u" placeholder="Steam account name" autocomplete="username" style="width:100%;box-sizing:border-box;margin:4px 0;padding:8px;background:#32404e;border:0;color:#fff;border-radius:3px">\n        <input name="p" type="password" placeholder="Password" autocomplete="current-password" style="width:100%;box-sizing:border-box;margin:4px 0;padding:8px;background:#32404e;border:0;color:#fff;border-radius:3px">\n        <label style="display:block;margin:8px 0;font-size:12px"><input name="r" type="checkbox" checked> Remember me in this browser</label>\n        <div data-guard style="display:none;margin:8px 0"></div>\n        <div data-msg style="min-height:18px;font-size:12px;color:#c6d4df;margin:6px 0"></div>\n        <button style="width:100%;padding:9px;border:0;border-radius:3px;background:linear-gradient(90deg,#06bfff,#2d73ff);color:#fff;font-weight:600;cursor:pointer">Sign in</button>\n        <div style="text-align:right;margin-top:8px"><a href="#" data-skip style="color:#8f98a0;font-size:12px">Play without Steam</a></div>\n        </form>\n        <div style="width:200px;text-align:center">\n          <div style="font-size:12px;font-weight:600;color:#1999ff;letter-spacing:.5px;margin:6px 0 10px">OR SIGN IN WITH QR</div>\n          <canvas data-qr width="200" height="200" style="position:static;inset:auto;display:block;margin:0 auto;aspect-ratio:auto;max-width:none;max-height:none;width:200px;height:200px;background:#fff;border-radius:6px"></canvas>\n          <div data-qrmsg style="font-size:12px;color:#8f98a0;margin-top:8px;min-height:32px">Getting a code from Steam…</div>\n        </div>\n      </div>`;
    document.body.appendChild(box);
    const f = box.querySelector("form"), msg = box.querySelector("[data-msg]"), guard = box.querySelector("[data-guard]");
    const canvas = box.querySelector("[data-qr]"), qrmsg = box.querySelector("[data-qrmsg]"), self = this;
    return {
      box,
      form: f,
      say(t) {
        msg.textContent = t;
      },
      qrSay(t) {
        qrmsg.textContent = t;
      },
      qr(url) {
        const q = self.qrCode(url), g = canvas.getContext("2d"), cell = Math.floor(canvas.width / (q.n + 8)), off = Math.floor((canvas.width - cell * q.n) / 2);
        g.fillStyle = "#fff";
        g.fillRect(0, 0, canvas.width, canvas.height);
        g.fillStyle = "#000";
        for (let y = 0; y < q.n; y++) for (let x = 0; x < q.n; x++) if (q.dark(x, y)) g.fillRect(off + x * cell, off + y * cell, cell, cell);
        canvas.dataset.url = url;
      },
      guard(kinds, submit) {
        guard.style.display = "block";
        const app = kinds.includes(4) ? "Approve the sign-in in the Steam Mobile App" : kinds.includes(5) ? "Open the link Steam emailed you" : "";
        guard.innerHTML = (app ? `<div style="margin-bottom:6px">${app}${submit ? ", or enter a code:" : "."}</div>` : "") + (submit ? `<input name="g" placeholder="${kinds.includes(3) ? "Steam Guard code from the app" : "Code Steam emailed you"}" style="width:100%;box-sizing:border-box;padding:8px;background:#32404e;border:0;color:#fff;border-radius:3px">` : "");
        f.querySelector("button").textContent = submit ? "Submit code" : "Waiting…";
        f.onsubmit = async e => {
          e.preventDefault();
          const g = f.querySelector("[name=g]");
          if (submit && g && g.value.trim()) {
            msg.textContent = "Checking the code…";
            try {
              await submit(g.value.trim());
            } catch (x) {
              msg.textContent = String(x.message || x);
            }
          }
        };
      },
      close() {
        box.remove();
      }
    };
  },
  async start(appid) {
    const s = this.get();
    if (s.starting) return s.starting;
    s.appid = appid;
    return s.starting = ((async () => {
      if (/[?&]steamlogout=1/.test(location.search)) try {
        localStorage.removeItem("uew_steam_session");
      } catch (e) {}
      try {
        await this.connect();
      } catch (e) {
        this.log(e.message);
        s.state = -1;
        return false;
      }
      let saved = null;
      try {
        saved = JSON.parse(localStorage.getItem("uew_steam_session") || "null");
      } catch (e) {}
      if (saved && saved.account && saved.refresh) {
        try {
          await this.logon(saved.account, saved.refresh);
          return this.ready();
        } catch (e) {
          this.log("stored sign-in no longer works: " + e.message);
          try {
            localStorage.removeItem("uew_steam_session");
          } catch (x) {}
          await this.connect().catch(() => {});
        }
      }
      for (;;) {
        const ui = this.dialog(), stop = {
          done: false
        };
        const r = await new Promise(resolve => {
          this.signInWithQR(ui, stop).then(t => {
            if (t) resolve({
              ...t,
              keep: ui.form.r.checked
            });
          }, e => ui.qrSay(String(e.message || e)));
          ui.box.querySelector("[data-skip]").onclick = e => {
            e.preventDefault();
            resolve(null);
          };
          ui.form.onsubmit = async e => {
            e.preventDefault();
            const u = ui.form.u.value.trim(), p = ui.form.p.value, keep = ui.form.r.checked;
            if (!u || !p) {
              ui.say("Enter your account name and password");
              return;
            }
            ui.say("Signing in…");
            try {
              const t = await this.signInWithPassword(u, p, ui);
              resolve({
                ...t,
                keep
              });
            } catch (x) {
              ui.say(String(x.message || x));
            }
          };
        });
        stop.done = true;
        ui.close();
        if (!r) {
          this.log("playing without Steam");
          s.state = -1;
          return false;
        }
        try {
          await this.logon(r.account, r.refresh);
          if (r.keep) try {
            localStorage.setItem("uew_steam_session", JSON.stringify({
              account: r.account,
              refresh: r.refresh
            }));
          } catch (e) {}
          return this.ready();
        } catch (e) {
          this.log(e.message);
          await this.connect().catch(() => {});
        }
      }
    }))();
  },
  async ready() {
    const s = this.get(), pb = this.pb, E = this.EMSG;
    s.state = 1;
    // playing the game, as the Steam client reports it
    this.send(E.ClientGamesPlayed, pb.enc([ [ 1, "m", pb.enc([ [ 2, "q", BigInt(s.appid) ] ]) ], [ 2, "v", 20 ] ]));
    for (let i = 0; i < 20 && !s.name; i++) await new Promise(r => setTimeout(r, 100));
    this.log(`signed in to Steam as ${s.name || "?"} (${s.steamid})`);
    this.ownership(s.appid).catch(e => this.log("no ownership ticket: " + e.message));
    return true;
  },
  async ownership(appid) {
    const s = this.get(), pb = this.pb;
    if (s.owner.has(appid)) return s.owner.get(appid);
    const r = await this.job(this.EMSG.ClientGetAppOwnershipTicket, pb.enc([ [ 1, "v", appid ] ]));
    if (pb.num(r.body, 1, 2) !== 1) throw new Error("Steam says this account does not own app " + appid);
    const t = pb.bytes(r.body, 3).slice();
    s.owner.set(appid, t);
    return t;
  },
  crc32(b) {
    let c = ~0;
    for (let i = 0; i < b.length; i++) {
      c ^= b[i];
      for (let k = 0; k < 8; k++) c = c >>> 1 ^ (3988292384 & -(c & 1));
    }
    return ~c >>> 0;
  },
  ticket(appid, type, identity) {
    const s = this.get(), pb = this.pb;
    const owner = s.owner.get(appid), token = s.tokens.shift();
    if (!owner || !token) return null;
    const a = new Uint8Array(4 + token.length + 28), dv = new DataView(a.buffer);
    dv.setUint32(0, token.length, true);
    a.set(token, 4);
    let o = 4 + token.length;
    dv.setUint32(o, 24, true);
    dv.setUint32(o + 4, 1, true);
    dv.setUint32(o + 8, type, true);
    a.set(crypto.getRandomValues(new Uint8Array(8)), o + 12);
    dv.setUint32(o + 20, performance.now() >>> 0, true);
    dv.setUint32(o + 24, ++s.seq, true);
    const crc = this.crc32(a);
    // Steam checks a ticket against this list: a service handed it before Steam acknowledges it rejects it as invalid
    const acked = new Promise(r => s.acks.set(crc, () => {
      s.acks.delete(crc);
      r(true);
    }));
    s.tickets.push({
      appid,
      crc,
      ticket: a,
      secret: identity ? (new TextEncoder).encode("str:" + identity + "\0") : null
    });
    this.sendAuthList();
    // the ticket's own length, web API ones too: the EOS SDK refuses a ticket padded to the 2560-byte buffer size
    // before sending it to Epic
    const out = new Uint8Array(a.length + 4 + owner.length);
    out.set(a);
    new DataView(out.buffer).setUint32(a.length, owner.length, true);
    out.set(owner, a.length + 4);
    return {
      crc,
      bytes: out,
      acked
    };
  },
  sendAuthList() {
    const s = this.get(), pb = this.pb;
    const apps = [ ...new Set(s.tickets.map(t => t.appid)) ];
    const fields = [ [ 1, "v", s.tokens.length ] ];
    for (const t of s.tickets) fields.push([ 4, "m", pb.enc([ [ 4, "q", BigInt(t.appid) ], [ 6, "v", t.crc ], [ 7, "y", t.ticket ], [ 8, "y", t.secret ] ]) ]);
    for (const a of apps) fields.push([ 5, "v", a ]);
    this.send(this.EMSG.ClientAuthList, pb.enc(fields), [ [ 10, "q", s.nextJob++ ] ]);
  },
  cancel(crc) {
    const s = this.get();
    s.tickets = s.tickets.filter(t => t.crc !== crc);
    this.sendAuthList();
  },
  async encryptedTicket(appid, userdata) {
    const pb = this.pb;
    const r = await this.job(this.EMSG.ClientRequestEncryptedAppTicket, pb.enc([ [ 1, "v", appid ], [ 2, "y", userdata ] ]));
    if (pb.num(r.body, 2, 2) !== 1) throw new Error("no encrypted app ticket (result " + pb.num(r.body, 2, 2) + ")");
    return pb.bytes(r.body, 3).slice();
  },
  request(fn) {
    const s = this.get(), id = s.nextReq++, r = {
      status: 0,
      bytes: null,
      crc: 0
    };
    s.reqs.set(id, r);
    fn().then(v => {
      r.bytes = v.bytes || v;
      r.crc = v.crc || 0;
      r.status = 1;
    }, e => {
      this.log(e.message);
      r.status = 2;
    });
    return id;
  }
};

function _scm_cancel(crc) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(48, 0, 1, crc);
  uewSCM.cancel(crc >>> 0);
}

var _scm_eticket_async = function(appid, data, len) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(49, 0, 1, appid, data, len);
  data >>>= 0;
  const u = (growMemViews(), HEAPU8).slice(data, data + len);
  return uewSCM.request(() => uewSCM.encryptedTicket(appid, u));
};

function _scm_req_free(id) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(50, 0, 1, id);
  uewSCM.get().reqs.delete(id);
}

function _scm_req_status(id) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(51, 0, 1, id);
  const r = uewSCM.get().reqs.get(id);
  return r ? r.status : 2;
}

function _scm_req_take(id, buf, cap, crcp) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(52, 0, 1, id, buf, cap, crcp);
  buf >>>= 0;
  crcp >>>= 0;
  const r = uewSCM.get().reqs.get(id);
  if (!r || r.status !== 1 || !r.bytes) return 0;
  const n = Math.min(cap, r.bytes.length);
  if (buf) (growMemViews(), HEAPU8).set(r.bytes.subarray(0, n), buf >>> 0);
  if (crcp) (growMemViews(), HEAPU32)[crcp >>> 2] = r.crc;
  return r.bytes.length;
}

function _scm_start(appid) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(53, 0, 1, appid);
  const cfg = Module.uewSteam || {};
  const mode = new URLSearchParams(location.search).get("steam") || cfg.mode;
  if (mode !== "account") return 0;
  Module.uewSteamClient = uewSCM;
  // for the debug panel and tests
  uewSCM.start(appid);
  return 1;
}

function _scm_state() {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(54, 0, 1);
  return uewSCM.get().state;
}

function _scm_ticket(appid, type, identity, buf, cap, crcp) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(55, 0, 1, appid, type, identity, buf, cap, crcp);
  identity >>>= 0;
  buf >>>= 0;
  crcp >>>= 0;
  const t = uewSCM.ticket(appid, type, identity ? UTF8ToString(identity) : "");
  if (!t || t.bytes.length > cap) return 0;
  (growMemViews(), HEAPU8).set(t.bytes, buf >>> 0);
  if (crcp) (growMemViews(), HEAPU32)[crcp >>> 2] = t.crc;
  return t.bytes.length;
}

function _scm_ticket_acked(crc) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(56, 0, 1, crc);
  return uewSCM.get().acked.has(crc >>> 0) ? 1 : 0;
}

var _scm_ticket_async = function(appid, type, identity) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(57, 0, 1, appid, type, identity);
  identity >>>= 0;
  const id = identity ? UTF8ToString(identity) : "";
  return uewSCM.request(async () => {
    await uewSCM.ownership(appid);
    for (let i = 0; i < 50 && !uewSCM.get().tokens.length; i++) await new Promise(r => setTimeout(r, 100));
    const t = uewSCM.ticket(appid, type, id);
    if (!t) throw new Error("no game connect token from Steam");
    const ok = await Promise.race([ t.acked, new Promise(r => setTimeout(() => r(false), 5e3)) ]);
    uewSCM.log(`web API ticket for ${id || "(no identity)"}: ${t.bytes.length} bytes, ${ok ? "registered with Steam" : "not acknowledged by Steam in 5 s"}`);
    return t;
  });
};

var _uew_js_frame_request = function(seq) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(58, 0, 1, seq);
  seq >>>= 0;
  if (!Module.uewWatchdog && typeof setInterval !== "undefined" && typeof document !== "undefined") {
    // a game that stops presenting while the page is visible: log what every thread is doing, once per stall
    let last = -1, since = performance.now(), dumped = false;
    Module.uewWatchdog = setInterval(() => {
      const n = Module.uewPresents || 0, now = performance.now();
      if (n !== last || document.visibilityState !== "visible") {
        last = n;
        since = now;
        dumped = false;
        return;
      }
      if (!dumped && n > 600 && now - since > 8e3 && Module._uew_threads) {
        dumped = true;
        console.log("[watchdog] no frame for 8 s; threads:");
        Module._uew_threads();
      }
    }, 1e3);
  }
  Module.uewFrameSeqPtr = seq;
  if (Module.uewFramePending) return;
  Module.uewFramePending = 1;
  const go = () => {
    Module.uewFramePending = 0;
    Module.uewFrameSeq = (Module.uewFrameSeq | 0) + 1;
    // the count lives in wasm memory, so threads on every core see it
    (growMemViews(), HEAP32)[Module.uewFrameSeqPtr / 4 >>> 0] = Module.uewFrameSeq;
    const w = Module.uewIdleWake;
    if (w) {
      Module.uewIdleWake = null;
      w();
    }
  };
  (typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame : setTimeout)(go);
};

function _uew_rf_find(path, size, mtime) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(59, 0, 1, path, size, mtime);
  path >>>= 0;
  size >>>= 0;
  mtime >>>= 0;
  const f = Module.uewFiles && Module.uewFiles.lookup(UTF8ToString(path));
  if (!f) return -2;
  (growMemViews(), HEAPF64)[size / 8 >>> 0] = f.size || 0;
  (growMemViews(), HEAPF64)[mtime / 8 >>> 0] = f.mtime || 0;
  return f.dir ? -1 : f.id;
}

function _uew_rf_list(path) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(60, 0, 1, path);
  path >>>= 0;
  const s = Module.uewFiles && Module.uewFiles.list(UTF8ToString(path));
  return s == null ? 0 : stringToNewUTF8(s);
}

function _uew_rf_read_cached(id, off, len, dst) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(61, 0, 1, id, off, len, dst);
  dst >>>= 0;
  return Module.uewFiles.readCached(id, off, len, dst);
}

function _uew_rf_ready(id, off, len) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(62, 0, 1, id, off, len);
  return Module.uewFiles.ready(id, off, len);
}

function _uew_rf_start(id, off, len) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(63, 0, 1, id, off, len);
  Module.uewFiles.start(id, off, len);
}

function _uew_vpx_available() {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(64, 0, 1);
  if (typeof VideoDecoder !== "function" || typeof EncodedVideoChunk !== "function") return 0;
  if (typeof location !== "undefined" && /[?&]swvideo=1/.test(location.search)) return 0;
  return Module.uewHwVideo === false ? 0 : 1;
}

function _uew_vpx_close(id) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(65, 0, 1, id);
  const V = Module.uewVpx, s = V && V.s.get(id);
  if (!s) return;
  try {
    if (s.dec.state !== "closed") s.dec.close();
  } catch (e) {}
  V.s.delete(id);
}

function _uew_vpx_decode(id, p, n, key) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(66, 0, 1, id, p, n, key);
  p >>>= 0;
  const s = Module.uewVpx.s.get(id);
  if (!s || s.err) return -1;
  try {
    if (s.dec.state === "unconfigured") {
      if (!key) return -1;
      s.dec.configure({
        codec: s.vp9 ? "vp09.00.10.08" : "vp8",
        optimizeForLatency: true,
        hardwareAcceleration: "prefer-hardware"
      });
    }
    s.dec.decode(new EncodedVideoChunk({
      type: key ? "key" : "delta",
      timestamp: ++s.ts,
      data: (growMemViews(), HEAPU8).slice(p, p + n)
    }));
    return 0;
  } catch (e) {
    s.err = true;
    return -1;
  }
}

function _uew_vpx_info(id, out) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(67, 0, 1, id, out);
  out >>>= 0;
  const s = Module.uewVpx.s.get(id), f = s && s.ready[0];
  if (!f) return 0;
  out /= 4;
  (growMemViews(), HEAP32)[out >>> 0] = f.w;
  (growMemViews(), HEAP32)[out + 1 >>> 0] = f.h;
  (growMemViews(), HEAP32)[out + 2 >>> 0] = f.matrix === "bt709" ? 2 : f.matrix === "bt470bg" ? 1 : f.matrix === "smpte170m" ? 3 : f.matrix === "smpte240m" ? 4 : f.matrix.startsWith("bt2020") ? 5 : f.matrix === "rgb" ? 7 : 0;
  (growMemViews(), HEAP32)[out + 3 >>> 0] = f.full ? 1 : 0;
  return 1;
}

function _uew_vpx_open(vp9) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(68, 0, 1, vp9);
  const V = Module.uewVpx || (Module.uewVpx = {
    n: 0,
    s: new Map
  });
  const id = ++V.n, s = {
    vp9,
    ready: [],
    err: false,
    ts: 0
  };
  try {
    s.dec = new VideoDecoder({
      output: f => {
        const rect = f.visibleRect, cs = f.colorSpace || {}, fmt = f.format;
        if (fmt !== "I420" && fmt !== "NV12") {
          if (!V.fmtLogged) {
            V.fmtLogged = 1;
            console.log("[video] decoder gives " + fmt + " pictures; using the software decoder");
          }
          f.close();
          s.err = true;
          return;
        }
        let buf;
        try {
          buf = new Uint8Array(f.allocationSize({
            rect
          }));
        } catch (e) {
          f.close();
          s.err = true;
          return;
        }
        const item = {
          buf,
          layout: null,
          fmt,
          w: rect.width,
          h: rect.height,
          matrix: cs.matrix || "",
          full: !!cs.fullRange
        };
        s.ready.push(item);
        f.copyTo(buf, {
          rect
        }).then(layout => {
          item.layout = layout;
          f.close();
        }, () => {
          f.close();
          s.err = true;
        });
      },
      error: e => {
        s.err = true;
        if (!V.errLogged) {
          V.errLogged = 1;
          console.log("[video] hardware decoder failed (" + e.message + "); using the software decoder");
        }
      }
    });
  } catch (e) {
    return 0;
  }
  V.s.set(id, s);
  return id;
}

function _uew_vpx_poll(id) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(69, 0, 1, id);
  const s = Module.uewVpx.s.get(id);
  if (!s || s.err) return 2;
  return s.ready.length && s.ready[0].layout ? 1 : 0;
}

function _uew_vpx_take(id, y, ys, u, us, v, vs) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(70, 0, 1, id, y, ys, u, us, v, vs);
  y >>>= 0;
  u >>>= 0;
  v >>>= 0;
  const s = Module.uewVpx.s.get(id), f = s && s.ready.shift();
  if (!f) return;
  const L = f.layout, b = f.buf, w = f.w, h = f.h, cw = (w + 1) >> 1, ch = (h + 1) >> 1, H = (growMemViews(), 
  HEAPU8);
  for (let r = 0; r < h; r++) H.set(b.subarray(L[0].offset + r * L[0].stride, L[0].offset + r * L[0].stride + w), y + r * ys);
  if (f.fmt === "I420") {
    for (let r = 0; r < ch; r++) {
      H.set(b.subarray(L[1].offset + r * L[1].stride, L[1].offset + r * L[1].stride + cw), u + r * us);
      H.set(b.subarray(L[2].offset + r * L[2].stride, L[2].offset + r * L[2].stride + cw), v + r * vs);
    }
  } else {
    for (let r = 0; r < ch; r++) {
      let o = L[1].offset + r * L[1].stride, du = u + r * us, dv = v + r * vs;
      for (let x = 0; x < cw; x++, o += 2) {
        H[du + x] = b[o];
        H[dv + x] = b[o + 1];
      }
    }
  }
}

var _uewg_begin_pass = function(jsonPtr) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(71, 0, 1, jsonPtr);
  jsonPtr >>>= 0;
  const g = Module.uewg;
  g.passBudget();
  g.endPass(true);
  const d = JSON.parse(UTF8ToString(jsonPtr));
  const colorAttachments = d.color.map(c => c ? {
    view: g.o[c.view],
    loadOp: "load",
    storeOp: "store",
    depthSlice: c.slice >= 0 ? c.slice : undefined
  } : null);
  let depthStencilAttachment;
  if (d.depth) {
    const z = d.depth;
    depthStencilAttachment = {
      view: g.o[z.view]
    };
    if (z.ro & 1) depthStencilAttachment.depthReadOnly = true; else Object.assign(depthStencilAttachment, {
      depthLoadOp: "load",
      depthStoreOp: "store"
    });
    if (z.stencil) {
      if (z.ro & 2) depthStencilAttachment.stencilReadOnly = true; else Object.assign(depthStencilAttachment, {
        stencilLoadOp: "load",
        stencilStoreOp: "store"
      });
    }
  }
  // the reopen descriptor always loads; the first opening takes over matching pending clears
  g.lastPass = {
    colorAttachments,
    depthStencilAttachment
  };
  let first = g.lastPass;
  if (g.pendClears.length) {
    const ca = colorAttachments.map(a => a && {
      ...a
    }), za = depthStencilAttachment && {
      ...depthStencilAttachment
    };
    for (const pc of g.pendClears) {
      for (const c of pc.color) {
        if (!c) continue;
        const k = ca.findIndex(a => a && a.view === c.view && (a.depthSlice ?? -1) === (c.slice >= 0 ? c.slice : -1));
        if (k >= 0) {
          ca[k].loadOp = "clear";
          ca[k].clearValue = c.clear;
          c.view = null;
        }
      }
      if (pc.depth && za && za.view === pc.depth.view && !za.depthReadOnly && !(pc.depth.stencil && pc.depth.sclear !== undefined && za.stencilReadOnly)) {
        if (pc.depth.dclear !== undefined) {
          za.depthLoadOp = "clear";
          za.depthClearValue = pc.depth.dclear;
        }
        if (pc.depth.sclear !== undefined && za.stencilLoadOp) {
          za.stencilLoadOp = "clear";
          za.stencilClearValue = pc.depth.sclear;
        }
        pc.depth = null;
      }
      pc.color = pc.color.filter(c => c && c.view);
    }
    g.pendClears = g.pendClears.filter(pc => pc.color.length || pc.depth);
    g.flushClears();
    first = {
      colorAttachments: ca,
      depthStencilAttachment: za
    };
  }
  g.stat.pass++;
  g.pass = g.encoder().beginRenderPass(first);
  if (g.cap) g.cap.cur = {
    pass: g.cap.events.length,
    desc: g.lastPass,
    draws: []
  };
};

function _uewg_bindgroup_bin(layoutId, group, ptr, n) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(72, 0, 1, layoutId, group, ptr, n);
  ptr >>>= 0;
  const g = Module.uewg;
  g.stat.bg++;
  const layout = layoutId < 0 ? g.emptyLayout : g.o[layoutId].bgls[group];
  const dims = {
    2: "1d",
    5: "3d",
    6: "cube",
    7: "2d-array",
    8: "2d-array",
    9: "2d-array",
    10: "cube-array"
  };
  const rets = [ "float", "sint", "uint", "depth" ];
  const dummies = [ null, null, null, "buf", "sbuf", "stex" ];
  const entries = [];
  for (let i = 0, p = ptr / 4; i < n; i++, p += 7) {
    const b = (growMemViews(), HEAP32)[p >>> 0], kind = (growMemViews(), HEAP32)[p + 1 >>> 0], id = (growMemViews(), 
    HEAP32)[p + 2 >>> 0];
    if (kind == 0) entries.push({
      binding: b,
      resource: g.o[id]
    }); else if (kind == 1) entries.push({
      binding: b,
      resource: {
        buffer: g.o[id],
        offset: (growMemViews(), HEAPU32)[p + 3 >>> 0],
        size: (growMemViews(), HEAPU32)[p + 4 >>> 0]
      }
    }); else {
      const x = g.dummy(kind == 2 ? `${dims[(growMemViews(), HEAP32)[p + 5 >>> 0]] || "2d"}:${rets[(growMemViews(), 
      HEAP32)[p + 6 >>> 0]] || "float"}` : dummies[kind]);
      entries.push({
        binding: b,
        resource: x instanceof GPUBuffer ? {
          buffer: x
        } : x
      });
    }
  }
  try {
    const bg = g.device.createBindGroup({
      layout,
      entries
    });
    if (g.capFrame) bg.__r = entries.map((e, i) => e.resource && e.resource.__tex ? e.resource.__tex.__id : e.resource && e.resource.buffer ? ((growMemViews(), 
    HEAP32)[ptr / 4 + 7 * i + 1 >>> 0] == 1 ? `b${(growMemViews(), HEAP32)[ptr / 4 + 7 * i + 2 >>> 0]}@${e.resource.offset}+${e.resource.size}` : "b") : e.resource instanceof GPUSampler ? "s" : "?");
    return g.add(bg);
  } catch (e) {
    if (g.errors++ < 40) console.log("[webgpu] bind group " + e.message);
    return 0;
  }
}

var _uewg_bindgroup_create = function(layoutId, group, jsonPtr) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(73, 0, 1, layoutId, group, jsonPtr);
  jsonPtr >>>= 0;
  const g = Module.uewg;
  if (window.uewLogCreates > 1) console.log(`[create] bindgroup`);
  g.stat.bg++;
  const layout = layoutId < 0 ? g.emptyLayout : g.o[layoutId].bgls[group];
  const entries = JSON.parse(UTF8ToString(jsonPtr)).map(e => {
    if (e.ring) return {
      binding: e.b,
      resource: {
        buffer: g.ring,
        offset: e.off || 0,
        size: e.size
      }
    };
    if (e.buf !== undefined) return {
      binding: e.b,
      resource: {
        buffer: g.o[e.buf],
        offset: e.off || 0,
        size: e.size
      }
    };
    if (e.dummy) {
      const x = g.dummy(e.dummy);
      return {
        binding: e.b,
        resource: x instanceof GPUBuffer ? {
          buffer: x
        } : x
      };
    }
    return {
      binding: e.b,
      resource: g.o[e.id]
    };
  });
  try {
    const bg = g.device.createBindGroup({
      layout,
      entries
    });
    if (g.capFrame) bg.__sz = JSON.parse(UTF8ToString(jsonPtr)).filter(e => e.ring).map(e => [ e.b, e.off || -1, e.size ]);
    if (g.capFrame) {
      const js = JSON.parse(UTF8ToString(jsonPtr));
      bg.__r = entries.map((e, i) => e.resource && e.resource.__tex ? e.resource.__tex.__id : e.resource && e.resource.buffer ? (js[i].buf !== undefined ? `b${js[i].buf}@${js[i].off || 0}+${js[i].size || 0}` : "b") : e.resource instanceof GPUSampler ? "s" : "?");
    }
    return g.add(bg);
  } catch (e) {
    if (g.errors++ < 40) console.log("[webgpu] bind group " + e.message);
    return 0;
  }
};

function _uewg_buffer_copy(src, srcOff, dst, dstOff, size) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(74, 0, 1, src, srcOff, dst, dstOff, size);
  const g = Module.uewg, a = g.o[src], b = g.o[dst];
  if (!a || !b) return;
  g.endPass();
  const n = Math.min(size, a.size - srcOff, b.size - dstOff) & ~3;
  if (n > 0) g.encoder().copyBufferToBuffer(a, srcOff, b, dstOff, n);
}

function _uewg_buffer_copy_ring(ringOff, dst, dstOff, size, ringUsed) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(75, 0, 1, ringOff, dst, dstOff, size, ringUsed);
  const g = Module.uewg, b = g.o[dst];
  if (!b) return;
  g.endPass();
  const n = Math.min(size, b.size - dstOff);
  if (n > 0) {
    g.encoder().copyBufferToBuffer(g.ring, ringOff, b, dstOff, n);
    g.stat.ringCopy++;
  }
}

function _uewg_buffer_create(size, usage) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(76, 0, 1, size, usage);
  const g = Module.uewg;
  let u = GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  if (usage & 1) u |= GPUBufferUsage.VERTEX;
  if (usage & 2) u |= GPUBufferUsage.INDEX;
  if (usage & 4) u |= GPUBufferUsage.UNIFORM;
  if (usage & 8) u |= GPUBufferUsage.STORAGE;
  if (usage & 16) u |= GPUBufferUsage.INDIRECT;
  try {
    return g.add(g.device.createBuffer({
      size: Math.max(256, (size + 255) & ~255),
      usage: u
    }));
  } catch (e) {
    console.log("[webgpu] buffer " + e.message);
    return 0;
  }
}

function _uewg_buffer_write(id, offset, ptr, size) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(77, 0, 1, id, offset, ptr, size);
  ptr >>>= 0;
  const g = Module.uewg, b = g.o[id];
  if (!b) return;
  const n = Math.min((size + 3) & ~3, b.size - offset);
  if (n > 0) {
    g.queue.writeBuffer(b, offset, (growMemViews(), HEAPU8), ptr, n);
    g.stat.write++;
    g.stat.writeBytes += n;
    g.queued(n);
    if (g.stat.by) g.stat.by.set(id, [ (g.stat.by.get(id) || [ 0 ])[0] + n, b.size, offset ]);
  }
}

function _uewg_clear(jsonPtr, ringUsed) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(78, 0, 1, jsonPtr, ringUsed);
  jsonPtr >>>= 0;
  const g = Module.uewg;
  g.endPass(true);
  const d = JSON.parse(UTF8ToString(jsonPtr));
  g.capEvent({
    clear: JSON.parse(JSON.stringify(d))
  });
  for (const c of d.color) c.view = g.o[c.view];
  if (d.depth) d.depth.view = g.o[d.depth.view];
  // a later clear of the same target replaces an earlier one
  for (const pc of g.pendClears) {
    pc.color = pc.color.filter(c => !d.color.some(n => n.view === c.view && n.slice === c.slice));
    if (pc.depth && d.depth && pc.depth.view === d.depth.view && d.depth.dclear !== undefined && (d.depth.sclear !== undefined || !pc.depth.stencil)) pc.depth = null;
  }
  g.pendClears = g.pendClears.filter(pc => pc.color.length || pc.depth);
  g.pendClears.push(d);
}

function _uewg_clear_buffer(id, off, size) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(79, 0, 1, id, off, size);
  const g = Module.uewg, b = g.o[id];
  if (!b) return;
  g.endPass();
  const n = Math.min(size, b.size - off) & ~3;
  if (n > 0) g.encoder().clearBuffer(b, off, n);
}

function _uewg_compute_pipeline_create(layoutId, cs) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(80, 0, 1, layoutId, cs);
  const g = Module.uewg;
  const desc = {
    layout: g.o[layoutId].pl,
    compute: {
      module: g.o[cs],
      entryPoint: "main"
    }
  };
  const done = p => {
    p.__cs = cs;
    p.__ps = cs;
    return p;
  };
  if (g.asyncShaders()) {
    const id = g.add(null);
    g.pendingPipes++;
    g.pending.add(id);
    g.device.createComputePipelineAsync(desc).then(p => {
      g.o[id] = done(p);
      g.pendingPipes--;
      g.pending.delete(id);
      Module.uewWake && Module.uewWake();
    }, e => {
      g.pendingPipes--;
      g.pending.delete(id);
      Module.uewWake && Module.uewWake();
      if (g.errors++ < 40) console.log("[webgpu] compute pipeline " + e.message);
    });
    return id;
  }
  try {
    return g.add(done(g.device.createComputePipeline(desc)));
  } catch (e) {
    if (g.errors++ < 40) console.log("[webgpu] compute pipeline " + e.message);
    return 0;
  }
}

function _uewg_copy_buffer(src, soff, dst, doff, size) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(81, 0, 1, src, soff, dst, doff, size);
  const g = Module.uewg, s = g.o[src], d = g.o[dst];
  if (!s || !d) return;
  g.endPass();
  const n = Math.min((size + 3) & ~3, s.size - soff, d.size - doff);
  if (n > 0) g.encoder().copyBufferToBuffer(s, soff, d, doff, n);
}

var _uewg_copy_texture = function(src, smip, slayer, sx, sy, sz, dst, dmip, dlayer, dx, dy, dz, w, h, d) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(82, 0, 1, src, smip, slayer, sx, sy, sz, dst, dmip, dlayer, dx, dy, dz, w, h, d);
  const g = Module.uewg;
  g.endPass();
  const isC = t => t && /^(bc|etc2|eac|astc)/.test(t.format);
  if (g.o[src] && g.o[dst] && isC(g.o[src]) !== isC(g.o[dst])) {
    // D3D copies between a block-compressed texture and an uncompressed one of the block's size (one texel per
    // block, e.g. RG32 <-> BC1); WebGPU only copies like formats, so the bytes go through a buffer
    const ct = isC(g.o[src]) ? g.o[src] : g.o[dst], bpu = /^(bc1|bc4)/.test(ct.format) ? 8 : 16;
    const uw = isC(g.o[src]) ? (w + 3) >> 2 : w, uh = isC(g.o[src]) ? (h + 3) >> 2 : h;
    const se = isC(g.o[src]) ? [ uw * 4, uh * 4, d ] : [ uw, uh, d ], de = isC(g.o[src]) ? [ uw, uh, d ] : [ uw * 4, uh * 4, d ];
    const bytesPerRow = (uw * bpu + 255) & ~255;
    try {
      const buf = g.device.createBuffer({
        size: bytesPerRow * uh * d,
        usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      });
      const enc = g.encoder();
      enc.copyTextureToBuffer({
        texture: g.o[src],
        mipLevel: smip,
        origin: [ sx, sy, sz + slayer ]
      }, {
        buffer: buf,
        bytesPerRow,
        rowsPerImage: uh
      }, se);
      enc.copyBufferToTexture({
        buffer: buf,
        bytesPerRow,
        rowsPerImage: uh
      }, {
        texture: g.o[dst],
        mipLevel: dmip,
        origin: [ dx, dy, dz + dlayer ]
      }, de);
    } catch (e) {
      if (g.errors++ < 40) console.log("[webgpu] copy " + e.message);
    }
    return;
  }
  if (isC(g.o[src])) {
    w = (w + 3) & ~3;
    h = (h + 3) & ~3;
  }
  try {
    g.encoder().copyTextureToTexture({
      texture: g.o[src],
      mipLevel: smip,
      origin: [ sx, sy, sz + slayer ]
    }, {
      texture: g.o[dst],
      mipLevel: dmip,
      origin: [ dx, dy, dz + dlayer ]
    }, [ w, h, d ]);
    g.capEvent({
      copy: [ src, smip, slayer, dst, dmip, dlayer, w, h, d ]
    });
  } catch (e) {
    if (g.errors++ < 40) console.log("[webgpu] copy " + e.message);
  }
};

var _uewg_dispatch = function(p) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(83, 0, 1, p);
  p >>>= 0;
  Module.uewg.guard("dispatch", () => {
    const g = Module.uewg, I = (growMemViews(), HEAP32);
    let i = p / 4;
    const pipe = g.o[I[i++]];
    const cb = I[i++], ndyn = I[i++];
    const dyn0 = i;
    i += ndyn;
    const res = I[i++], x = I[i++], y = I[i++], z = I[i++];
    if (!pipe) return;
    g.passBudget();
    g.endPass();
    const cp = g.encoder().beginComputePass();
    cp.setPipeline(pipe);
    if (g.prof && g.prof.cur) {
      g.prof.cur.draws++;
      g.prof.cur.pipes.set(I[p / 4], 1);
    }
    cp.setBindGroup(0, g.o[cb], (growMemViews(), HEAPU32), dyn0, ndyn);
    cp.setBindGroup(1, g.o[res]);
    if (x === -1) cp.dispatchWorkgroupsIndirect(g.o[y], z); else cp.dispatchWorkgroups(x, y, z);
    cp.end();
    if (g.cap) g.capEvent({
      dispatch: [ x, y, z ],
      cs: pipe.__cs,
      res: g.o[res] && g.o[res].__r
    });
  });
};

function _uewg_draw(p) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(84, 0, 1, p);
  p >>>= 0;
  try {
    const g = Module.uewg;
    // a copy or dispatch since the last draw ended the pass: carry on with the same targets
    if (!g.pass && g.lastPass) {
      g.stat.reopen++;
      g.openPass();
    }
    const pass = g.pass;
    if (!pass) {
      g.skip.nopass++;
      return;
    }
    const I = (growMemViews(), HEAP32), F = (growMemViews(), HEAPF32);
    let i = p / 4;
    const pipeId = I[i++], pipe = g.o[pipeId];
    if (!pipe) {
      g.skip.nopipe++;
      return;
    }
    // state already set in this pass is not set again
    let st = g.pst;
    if (!st || st.pass !== pass) {
      st = g.pst = {
        pass,
        pipe: -1,
        bg: new Int32Array(4).fill(-1),
        off: new Uint32Array(32),
        nd: new Int32Array(4),
        vb: new Int32Array(48).fill(-2),
        vp: new Float32Array(6).fill(NaN),
        sc: new Int32Array(4).fill(-1),
        sref: -1,
        bc: new Float32Array(4).fill(NaN),
        ib: new Int32Array(3).fill(-2)
      };
    }
    if (st.pipe !== pipeId) {
      pass.setPipeline(pipe);
      st.pipe = pipeId;
    }
    if (g.prof && g.prof.cur) {
      const c = g.prof.cur;
      c.draws++;
      c.pipes.set(pipeId, (c.pipes.get(pipeId) || 0) + 1);
    }
    const ngroups = I[i++];
    // a group whose object is gone would invalidate the whole frame's commands: drop just this draw
    for (let k = 0, j = i; k < ngroups; k++) {
      if (!g.o[I[j]]) {
        g.skip.nobg = (g.skip.nobg || 0) + 1;
        if ((g.nobgLogged = (g.nobgLogged || 0) + 1) <= 5) console.log(`[webgpu] draw skipped: bind group ${k} (id ${I[j]}) is missing, pipeline ${pipeId}`);
        return;
      }
      j += 2 + I[j + 1];
    }
    for (let k = 0; k < ngroups; k++) {
      const bg = I[i++], ndyn = I[i++];
      let same = st.bg[k] === bg && st.nd[k] === ndyn;
      for (let d = 0; d < ndyn && same; d++) if (st.off[k * 8 + d] !== (growMemViews(), 
      HEAPU32)[i + d >>> 0]) same = false;
      if (!same) {
        // offsets straight from the heap: no array per call
        pass.setBindGroup(k, g.o[bg], (growMemViews(), HEAPU32), i, ndyn);
        st.bg[k] = bg;
        st.nd[k] = ndyn;
        for (let d = 0; d < ndyn && d < 8; d++) st.off[k * 8 + d] = (growMemViews(), HEAPU32)[i + d >>> 0];
      }
      i += ndyn;
    }
    const nvb = I[i++];
    for (let k = 0; k < nvb; k++) {
      const slot = I[i], id = I[i + 1], off = I[i + 2], o = slot * 3;
      if (st.vb[o] !== id || st.vb[o + 1] !== off) {
        pass.setVertexBuffer(slot, id === -3 ? g.ring : id < 0 ? g.zeroVB() : g.o[id], off);
        st.vb[o] = id;
        st.vb[o + 1] = off;
      }
      i += 3;
    }
    if (st.vp[0] !== F[i] || st.vp[1] !== F[i + 1] || st.vp[2] !== F[i + 2] || st.vp[3] !== F[i + 3] || st.vp[4] !== F[i + 4] || st.vp[5] !== F[i + 5]) {
      pass.setViewport(F[i], F[i + 1], F[i + 2], F[i + 3], F[i + 4], F[i + 5]);
      for (let k = 0; k < 6; k++) st.vp[k] = F[i + k];
    }
    i += 6;
    if (st.sc[0] !== I[i] || st.sc[1] !== I[i + 1] || st.sc[2] !== I[i + 2] || st.sc[3] !== I[i + 3]) {
      pass.setScissorRect(I[i], I[i + 1], I[i + 2], I[i + 3]);
      st.sc[0] = I[i];
      st.sc[1] = I[i + 1];
      st.sc[2] = I[i + 2];
      st.sc[3] = I[i + 3];
    }
    i += 4;
    const sref = I[i] >>> 0;
    if (st.sref !== sref) {
      pass.setStencilReference(sref);
      st.sref = sref;
    }
    i++;
    if (st.bc[0] !== F[i] || st.bc[1] !== F[i + 1] || st.bc[2] !== F[i + 2] || st.bc[3] !== F[i + 3]) {
      pass.setBlendConstant([ F[i], F[i + 1], F[i + 2], F[i + 3] ]);
      st.bc.set(F.subarray(i, i + 4));
    }
    i += 4;
    const indexed = I[i++], count = I[i++], instances = I[i++], first = I[i++], baseVertex = I[i++], firstInstance = I[i++];
    // count -1: indirect, with the arguments buffer and offset in place of instances and first
    if (indexed) {
      if (st.ib[0] !== I[i] || st.ib[1] !== I[i + 1] || st.ib[2] !== I[i + 2]) {
        pass.setIndexBuffer(I[i] === -3 ? g.ring : g.o[I[i]], I[i + 1] ? "uint32" : "uint16", I[i + 2]);
        st.ib.set(I.subarray(i, i + 3));
      }
      if (count === -1) pass.drawIndexedIndirect(g.o[instances], first); else pass.drawIndexed(count, instances, first, baseVertex, firstInstance);
      g.stat.draws++;
    } else if (count === -1) pass.drawIndirect(g.o[instances], first); else pass.draw(count, instances, first, firstInstance);
    if (g.cap && g.cap.cur && g.cap.cur.draws.length < 3e3) {
      const pd = pipe.__d || {};
      const groups = [], cbs = {};
      for (let k = 0, j = p / 4 + 2; k < ngroups; k++) {
        const bg = g.o[I[j]], nd = I[j + 1];
        groups.push(bg && bg.__r);
        // constant buffer contents straight from the ring (first draws of a pass only)
        if (bg && bg.__sz && (g.cap.cur.draws.length < 8 || count === window.uewCaptureBufCount)) {
          let d = 0;
          for (const [b, off, size] of bg.__sz) {
            const o = off >= 0 ? off : (growMemViews(), HEAPU32)[j + 2 + d++ >>> 0];
            cbs[`${k}:${b}`] = Array.from((growMemViews(), HEAPF32).subarray((g.ringPtr + o) / 4 >>> 0, (g.ringPtr + o + size) / 4 >>> 0)).map(x => +x.toPrecision(5));
          }
        }
        j += 2 + nd;
      }
      g.cap.cur.draws.push({
        vs: pd.vs,
        ps: pd.ps,
        count,
        instances,
        indexed,
        first,
        baseVertex,
        topo: pd.primitive && pd.primitive.topology,
        targets: pd.targets,
        depth: pd.depth,
        buffers: pd.buffers,
        prim: pd.primitive,
        vp: Array.from(st.vp),
        sc: Array.from(st.sc),
        sref,
        res: groups,
        cbs,
        firstInstance,
        vbs: Array.from({
          length: 16
        }, (_, k) => [ k, st.vb[k * 3], st.vb[k * 3 + 1] ]).filter(v => v[1] > 0)
      });
      // debug: window.uewCapturePixels = [[x, y], ...] samples depth and colour target 0 there after every draw
      if (window.uewCapturePixels && g.cap.px.length < 400) {
        pass.end();
        const enc = g.encoder(), atts = [];
        const z = g.lastPass.depthStencilAttachment, zt = z && z.view.__tex;
        if (zt && zt.format === "depth32float-stencil8") atts.push([ "z", zt, "depth-only", 4 ]);
        const c0 = g.lastPass.colorAttachments[0], ct = c0 && c0.view.__tex;
        if (ct && ct.format === "rgba16float" && ct.dimension === "2d") atts.push([ "c", ct, "all", 8 ]);
        for (const [kind, t, aspect, bpp] of atts) {
          // depth can only be copied whole
          const bpr = (t.width * bpp + 255) & ~255;
          const buf = g.device.createBuffer({
            size: bpr * t.height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
          });
          enc.copyTextureToBuffer({
            texture: t,
            aspect
          }, {
            buffer: buf,
            bytesPerRow: bpr,
            rowsPerImage: t.height
          }, [ t.width, t.height, 1 ]);
          g.cap.px.push({
            buf,
            kind,
            bpr,
            bpp,
            w: t.width,
            h: t.height,
            pass: g.cap.cur.pass,
            draw: g.cap.cur.draws.length - 1,
            ps: pd.ps,
            vs: pd.vs,
            n: count,
            first
          });
        }
        g.pass = g.encoder().beginRenderPass(g.lastPass);
      }
      // debug: window.uewCapturePerDraw reads colour target 0 back after every draw of the frame
      const a0 = window.uewCapturePerDraw && g.lastPass.colorAttachments[0], t0 = a0 && a0.view.__tex;
      if (t0 && t0.format === "rgba16float" && t0.dimension === "2d" && g.cap.perDraw.length < 200) {
        g.pass.end();
        const w = t0.width, h = t0.height, bpr = (w * 8 + 255) & ~255;
        const buf = g.device.createBuffer({
          size: bpr * h,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
        g.encoder().copyTextureToBuffer({
          texture: t0
        }, {
          buffer: buf,
          bytesPerRow: bpr,
          rowsPerImage: h
        }, [ w, h, 1 ]);
        g.cap.perDraw.push({
          buf,
          w,
          h,
          bpr,
          pass: g.cap.cur.pass,
          draw: g.cap.cur.draws.length - 1,
          ps: pd.ps,
          tex: t0.__id
        });
        g.pass = g.encoder().beginRenderPass(g.lastPass);
      }
    }
    g.draws++;
  } catch (e) {
    Module.uewg.fail("draw", e);
  }
}

function _uewg_expand_typed(srcId, dstId, first, n, fmt, bpe) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(85, 0, 1, srcId, dstId, first, n, fmt, bpe);
  const g = Module.uewg, src = g.o[srcId], dst = g.o[dstId];
  if (!src || !dst || !n) return;
  if (!g.expand) {
    const m = g.device.createShaderModule({
      code: `struct P { first: u32, n: u32, fmt: u32, bpe: u32 }\n@group(0) @binding(0) var<storage, read> src: array<u32>;\n@group(0) @binding(1) var<storage, read_write> dst: array<vec4<u32>>;\n@group(0) @binding(2) var<uniform> p: P;\nfn b8(o: u32) -> u32 { return (src[o >> 2u] >> ((o & 3u) * 8u)) & 0xFFu; }\nfn b16(o: u32) -> u32 { return b8(o) | (b8(o + 1u) << 8u); }\nfn w32(o: u32) -> u32 { return b16(o) | (b16(o + 2u) << 16u); }\nfn fb(x: f32) -> u32 { return bitcast<u32>(x); }\nfn h(o: u32) -> u32 { return fb(unpack2x16float(b16(o)).x); }\nfn un8(o: u32) -> u32 { return fb(f32(b8(o)) / 255.0); }\nfn sn8(o: u32) -> u32 { return fb(max(f32(i32(b8(o) << 24u) >> 24u) / 127.0, -1.0)); }\nfn un16(o: u32) -> u32 { return fb(f32(b16(o)) / 65535.0); }\nfn sn16(o: u32) -> u32 { return fb(max(f32(i32(b16(o) << 16u) >> 16u) / 32767.0, -1.0)); }\nfn si8(o: u32) -> u32 { return bitcast<u32>(i32(b8(o) << 24u) >> 24u); }\nfn si16(o: u32) -> u32 { return bitcast<u32>(i32(b16(o) << 16u) >> 16u); }\nfn small(v: u32, sh: u32) -> u32 { return fb(unpack2x16float(v << sh).x); }\n@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {\n  let i = id.x + id.y * 4194240u;\n  if (i >= p.n) { return; }\n  let o = (p.first + i) * p.bpe;\n  var r = vec4<u32>(0u, 0u, 0u, 0x3F800000u);\n  switch p.fmt {\n    case 2u, 3u, 4u: { r = vec4<u32>(w32(o), w32(o + 4u), w32(o + 8u), w32(o + 12u)); }\n    case 6u, 7u, 8u: { r.x = w32(o); r.y = w32(o + 4u); r.z = w32(o + 8u); }\n    case 16u, 17u, 18u: { r.x = w32(o); r.y = w32(o + 4u); }\n    case 10u: { r = vec4<u32>(h(o), h(o + 2u), h(o + 4u), h(o + 6u)); }\n    case 34u: { r.x = h(o); r.y = h(o + 2u); }\n    case 54u: { r.x = h(o); }\n    case 28u, 29u: { r = vec4<u32>(un8(o), un8(o + 1u), un8(o + 2u), un8(o + 3u)); }\n    case 87u: { r = vec4<u32>(un8(o + 2u), un8(o + 1u), un8(o), un8(o + 3u)); }\n    case 88u: { r.x = un8(o + 2u); r.y = un8(o + 1u); r.z = un8(o); }\n    case 30u: { r = vec4<u32>(b8(o), b8(o + 1u), b8(o + 2u), b8(o + 3u)); }\n    case 12u: { r = vec4<u32>(b16(o), b16(o + 2u), b16(o + 4u), b16(o + 6u)); }\n    case 36u: { r.x = b16(o); r.y = b16(o + 2u); }\n    case 57u: { r.x = b16(o); }\n    case 62u: { r.x = b8(o); }\n    case 61u: { r.x = un8(o); }\n    case 56u: { r.x = un16(o); }\n    case 35u: { r.x = un16(o); r.y = un16(o + 2u); }\n    case 11u: { r = vec4<u32>(un16(o), un16(o + 2u), un16(o + 4u), un16(o + 6u)); }\n    case 31u: { r = vec4<u32>(sn8(o), sn8(o + 1u), sn8(o + 2u), sn8(o + 3u)); }\n    case 51u: { r.x = sn8(o); r.y = sn8(o + 1u); }\n    case 63u: { r.x = sn8(o); }\n    case 13u: { r = vec4<u32>(sn16(o), sn16(o + 2u), sn16(o + 4u), sn16(o + 6u)); }\n    case 37u: { r.x = sn16(o); r.y = sn16(o + 2u); }\n    case 58u: { r.x = sn16(o); }\n    case 49u: { r.x = un8(o); r.y = un8(o + 1u); }\n    case 50u: { r.x = b8(o); r.y = b8(o + 1u); }\n    case 32u: { r = vec4<u32>(si8(o), si8(o + 1u), si8(o + 2u), si8(o + 3u)); }\n    case 52u: { r.x = si8(o); r.y = si8(o + 1u); }\n    case 64u: { r.x = si8(o); }\n    case 14u: { r = vec4<u32>(si16(o), si16(o + 2u), si16(o + 4u), si16(o + 6u)); }\n    case 38u: { r.x = si16(o); r.y = si16(o + 2u); }\n    case 59u: { r.x = si16(o); }\n    case 24u: { let v = w32(o); r = vec4<u32>(fb(f32(v & 1023u) / 1023.0), fb(f32((v >> 10u) & 1023u) / 1023.0), fb(f32((v >> 20u) & 1023u) / 1023.0), fb(f32(v >> 30u) / 3.0)); }\n    case 25u: { let v = w32(o); r = vec4<u32>(v & 1023u, (v >> 10u) & 1023u, (v >> 20u) & 1023u, v >> 30u); }\n    case 26u: { let v = w32(o); r.x = small(v & 2047u, 4u); r.y = small((v >> 11u) & 2047u, 4u); r.z = small(v >> 22u, 5u); }\n    default: { r.x = w32(o); }\n  }\n  dst[i] = r;\n}`
    });
    g.expand = g.device.createComputePipeline({
      layout: "auto",
      compute: {
        module: m,
        entryPoint: "main"
      }
    });
  }
  const ub = g.device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  g.queue.writeBuffer(ub, 0, new Uint32Array([ first, n, fmt, bpe ]));
  const bg = g.device.createBindGroup({
    layout: g.expand.getBindGroupLayout(0),
    entries: [ {
      binding: 0,
      resource: {
        buffer: src
      }
    }, {
      binding: 1,
      resource: {
        buffer: dst
      }
    }, {
      binding: 2,
      resource: {
        buffer: ub
      }
    } ]
  });
  g.endPass();
  const cp = g.encoder().beginComputePass();
  cp.setPipeline(g.expand);
  cp.setBindGroup(0, bg);
  const groups = Math.ceil(n / 64);
  cp.dispatchWorkgroups(Math.min(groups, 65535), Math.ceil(groups / 65535));
  cp.end();
  (g.expandTmp || (g.expandTmp = [])).push(ub);
}

function _uewg_flush(ringUsed) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(86, 0, 1, ringUsed);
  Module.uewg.flush(ringUsed);
  Module.uewg.ringDone = 0;
}

var _uewg_gen_mips = function(id) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(87, 0, 1, id);
  Module.uewg.guard("mips", () => {
    const g = Module.uewg, t = g.o[id];
    if (!(t instanceof GPUTexture) || t.mipLevelCount < 2 || t.dimension !== "2d" || /^(bc|depth|stencil)|int$/.test(t.format)) return;
    g.endPass();
    if (!g.mipMod) {
      g.mipMod = g.device.createShaderModule({
        code: `@group(0) @binding(0) var t: texture_2d<f32>; @group(0) @binding(1) var s: sampler;\n        struct V { @builtin(position) p: vec4<f32>, @location(0) uv: vec2<f32> };\n        @vertex fn vs(@builtin(vertex_index) i: u32) -> V { let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u)); var o: V; o.p = vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0); o.uv = uv; return o; }\n        @fragment fn fs(v: V) -> @location(0) vec4<f32> { return textureSampleLevel(t, s, v.uv, 0.0); }`
      });
      g.mipSampler = g.device.createSampler({
        magFilter: "linear",
        minFilter: "linear"
      });
      g.mipPipes = new Map;
    }
    let pipe = g.mipPipes.get(t.format);
    if (!pipe) {
      pipe = g.device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: g.mipMod,
          entryPoint: "vs"
        },
        fragment: {
          module: g.mipMod,
          entryPoint: "fs",
          targets: [ {
            format: t.format
          } ]
        }
      });
      g.mipPipes.set(t.format, pipe);
    }
    const enc = g.encoder();
    for (let layer = 0; layer < t.depthOrArrayLayers; layer++) for (let m = 1; m < t.mipLevelCount; m++) {
      const view = k => t.createView({
        dimension: "2d",
        baseMipLevel: k,
        mipLevelCount: 1,
        baseArrayLayer: layer,
        arrayLayerCount: 1
      });
      const bg = g.device.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: [ {
          binding: 0,
          resource: view(m - 1)
        }, {
          binding: 1,
          resource: g.mipSampler
        } ]
      });
      const p = enc.beginRenderPass({
        colorAttachments: [ {
          view: view(m),
          loadOp: "clear",
          storeOp: "store",
          clearValue: [ 0, 0, 0, 0 ]
        } ]
      });
      p.setPipeline(pipe);
      p.setBindGroup(0, bg);
      p.draw(3);
      p.end();
    }
  });
};

var _uewg_gs = function(p) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(88, 0, 1, p);
  p >>>= 0;
  Module.uewg.guard("gs", () => {
    const g = Module.uewg, I = (growMemViews(), HEAP32), F = (growMemViews(), HEAPF32);
    let i = p / 4;
    const cpipe = g.o[I[i++]], wx = I[i++], wy = I[i++], nl = I[i++], cap = I[i++], args = g.o[I[i++]];
    const groups = () => {
      const r = [];
      for (let k = 0; k < 4; k++) {
        const bg = I[i++], nd = I[i++];
        r.push([ g.o[bg], i, nd ]);
        i += nd;
      }
      return r;
    };
    const cg = groups();
    const rpipe = g.o[I[i++]];
    const rg = groups();
    const vp = [ F[i], F[i + 1], F[i + 2], F[i + 3], F[i + 4], F[i + 5] ];
    i += 6;
    const sc = [ I[i], I[i + 1], I[i + 2], I[i + 3] ];
    i += 4;
    const sref = I[i++] >>> 0, bc = [ F[i], F[i + 1], F[i + 2], F[i + 3] ];
    i += 4;
    const ncol = I[i++], hasDepth = I[i++], stencil = I[i++], ro = I[i++];
    if (!cpipe || !rpipe || !args) {
      g.skip.nopipe++;
      return;
    }
    g.endPass();
    const enc = g.encoder();
    enc.clearBuffer(args, 0, nl * 16);
    if (!g.gsFix) {
      const m = g.device.createShaderModule({
        code: `@group(0) @binding(0) var<storage, read_write> a: array<u32>; @group(0) @binding(1) var<uniform> q: vec4<u32>;\n        @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) { let l = id.x; if (l >= q.y) { return; }\n        a[l * 4u] = min(a[l * 4u], q.x); a[l * 4u + 1u] = 1u; a[l * 4u + 2u] = l * q.x; a[l * 4u + 3u] = 0u; }`
      });
      g.gsFix = g.device.createComputePipeline({
        layout: "auto",
        compute: {
          module: m,
          entryPoint: "main"
        }
      });
      g.gsFixUB = new Map;
    }
    const key = cap + ":" + nl;
    let ub = g.gsFixUB.get(key);
    if (!ub) {
      ub = g.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      g.queue.writeBuffer(ub, 0, new Uint32Array([ cap, nl, 0, 0 ]));
      g.gsFixUB.set(key, ub);
    }
    const cp = enc.beginComputePass();
    cp.setPipeline(cpipe);
    for (let k = 0; k < 4; k++) cp.setBindGroup(k, cg[k][0], (growMemViews(), HEAPU32), cg[k][1], cg[k][2]);
    cp.dispatchWorkgroups(wx, wy);
    cp.setPipeline(g.gsFix);
    cp.setBindGroup(0, g.device.createBindGroup({
      layout: g.gsFix.getBindGroupLayout(0),
      entries: [ {
        binding: 0,
        resource: {
          buffer: args
        }
      }, {
        binding: 1,
        resource: {
          buffer: ub
        }
      } ]
    }));
    cp.dispatchWorkgroups(Math.ceil(nl / 64));
    cp.end();
    for (let L = 0; L < nl; L++) {
      const colorAttachments = [];
      for (let c = 0; c < ncol; c++) {
        const v = I[i++], sl = I[i++];
        colorAttachments.push(v ? {
          view: g.o[v],
          loadOp: "load",
          storeOp: "store",
          depthSlice: sl >= 0 ? sl : undefined
        } : null);
      }
      let depthStencilAttachment;
      if (hasDepth) {
        depthStencilAttachment = {
          view: g.o[I[i++]]
        };
        if (ro & 1) depthStencilAttachment.depthReadOnly = true; else Object.assign(depthStencilAttachment, {
          depthLoadOp: "load",
          depthStoreOp: "store"
        });
        if (stencil) {
          if (ro & 2) depthStencilAttachment.stencilReadOnly = true; else Object.assign(depthStencilAttachment, {
            stencilLoadOp: "load",
            stencilStoreOp: "store"
          });
        }
      }
      const pass = enc.beginRenderPass({
        colorAttachments,
        depthStencilAttachment
      });
      pass.setPipeline(rpipe);
      for (let k = 0; k < 4; k++) pass.setBindGroup(k, rg[k][0], (growMemViews(), HEAPU32), rg[k][1], rg[k][2]);
      pass.setViewport(vp[0], vp[1], vp[2], vp[3], vp[4], vp[5]);
      pass.setScissorRect(sc[0], sc[1], sc[2], sc[3]);
      pass.setStencilReference(sref);
      pass.setBlendConstant(bc);
      pass.drawIndirect(args, L * 16);
      pass.end();
    }
    g.capEvent({
      gs: nl,
      cap
    });
    g.draws++;
  });
};

function _uewg_has_feature(name) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(89, 0, 1, name);
  name >>>= 0;
  return Module.uewg.features.has(UTF8ToString(name)) ? 1 : 0;
}

async function _uewg_init(canvasW, canvasH, ringPtr, ringSize) {
  ringPtr >>>= 0;
  if (!navigator.gpu) return 0;
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance"
  });
  if (!adapter) return 0;
  const want = [ "texture-compression-bc", "texture-compression-bc-sliced-3d", "float32-filterable", "float32-blendable", "rg11b10ufloat-renderable", "depth32float-stencil8", "depth-clip-control", "indirect-first-instance", "texture-formats-tier1", "texture-formats-tier2", "texture-component-swizzle", "bgra8unorm-storage", "dual-source-blending" ];
  // debug: ?gpuprof=1 (or window.uewGpuProfile = 1 before the game starts) times every pass on the GPU and logs the slowest ones
  if (typeof window !== "undefined" && (window.uewGpuProfile || (typeof location !== "undefined" && /[?&]gpuprof=1(&|$)/.test(location.search)))) want.push("timestamp-query");
  const features = want.filter(f => adapter.features.has(f));
  const L = adapter.limits, req = {};
  for (const k of [ "maxSampledTexturesPerShaderStage", "maxSamplersPerShaderStage", "maxStorageBuffersPerShaderStage", "maxStorageTexturesPerShaderStage", "maxUniformBuffersPerShaderStage", "maxBindingsPerBindGroup", "maxInterStageShaderVariables", "maxColorAttachmentBytesPerSample", "maxBufferSize", "maxStorageBufferBindingSize", "maxDynamicUniformBuffersPerPipelineLayout", "maxComputeWorkgroupStorageSize", "maxComputeInvocationsPerWorkgroup", "maxTextureArrayLayers", "maxTextureDimension2D", "maxVertexAttributes", "maxVertexBuffers", "maxComputeWorkgroupSizeX", "maxComputeWorkgroupSizeY", "maxComputeWorkgroupSizeZ", "maxComputeWorkgroupsPerDimension", "maxTextureDimension3D", "maxTextureDimension1D", "maxBindGroups" ]) if (k in L) req[k] = L[k];
  let device;
  try {
    device = await adapter.requestDevice({
      requiredFeatures: features,
      requiredLimits: req
    });
  } catch (e) {
    console.log("[webgpu] requestDevice failed: " + e.message);
    return 0;
  }
  const canvas = Module.canvas || document.getElementById("canvas");
  const ctx = canvas && canvas.getContext("webgpu");
  if (!ctx) return 0;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({
    device,
    format,
    alphaMode: "opaque"
  });
  const g = Module.uewg = {
    device,
    queue: device.queue,
    ctx,
    canvasFormat: format,
    o: [ null ],
    free: [],
    features: new Set(features),
    errors: 0,
    ring: device.createBuffer({
      size: ringSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    }),
    ringPtr,
    enc: null,
    pass: null,
    blit: null,
    frames: 0,
    draws: 0,
    dummies: new Map
  };
  g.errKinds = new Map;
  // a lost device (driver reset, Windows' GPU watchdog after a ~2 s frame, GPU process crash) leaves the canvas black
  // for good while the game keeps running: say so in the log and on the page instead of failing silently
  device.lost.then(info => {
    if (info.reason === "destroyed") return;
    g.lost = info;
    console.log(`[webgpu] DEVICE LOST (${info.reason}): ${info.message}. The picture stays black until the page is reloaded; ` + "see docs/RENDERING.md, 'Black after it was working'.");
    const s = typeof document !== "undefined" && document.getElementById("status");
    if (s) {
      s.textContent = "The graphics device was lost (GPU reset or driver crash). Reload the page to continue.";
      s.style.color = "#f88";
    }
  });
  device.addEventListener("uncapturederror", e => {
    const m = e.error.message;
    if (g.errors++ < 40) console.log("[webgpu] " + m.split("\n").slice(0, 3).join(" | "));
    const kind = m.split("\n")[0].replace(/\[[^\]]*\]/g, "[]").replace(/\d+/g, "N").slice(0, 140);
    g.errKinds.set(kind, (g.errKinds.get(kind) || 0) + 1);
  });
  // Windows resets a GPU stuck on one batch for ~2 s; the browser then loses the device for good and every draw after
  // it is dropped (sound and game keep going over a blank screen). Reload once to get a new device; saves flush on pagehide
  device.lost.then(info => {
    g.lost = true;
    console.log(`[webgpu] device lost (${info.reason}): ${info.message}`);
    const st = typeof document !== "undefined" && document.getElementById("status");
    let last = 0;
    try {
      last = +sessionStorage.getItem("uewGpuReload") || 0;
    } catch (_) {}
    if (Date.now() - last > 3e5) {
      try {
        sessionStorage.setItem("uewGpuReload", Date.now());
      } catch (_) {}
      if (st) st.textContent = "The graphics driver reset. Restarting…";
      setTimeout(() => location.reload(), 1500);
    } else if (st) st.textContent = "The graphics driver reset again. Close other GPU-heavy programs, or set the browser to the high-performance GPU, then reload.";
  });
  // queue uploads ride along with the next submission; a loading frame can carry hundreds of MB, more than a slow GPU
  // copies inside the watchdog's window, so they go up in bounded batches
  g.queuedBytes = 0;
  g.queueLimit = 32 << 20;
  g.queued = n => {
    if ((g.queuedBytes += n) > g.queueLimit) {
      g.queuedBytes = 0;
      g.queue.submit([]);
    }
  };
  g.add = x => {
    if (g.free.length) {
      const i = g.free.pop();
      g.o[i] = x;
      return i;
    }
    g.o.push(x);
    return g.o.length - 1;
  };
  g.encoder = () => g.enc || (g.enc = device.createCommandEncoder());
  // background shader compiles: on unless the page asks for ?syncshaders=1 or the build turned them off
  g.pendingPipes = 0;
  g.pending = new Set;
  // ?skipshaders=1: draws whose pipeline is still compiling are dropped instead of waited for (faster, but an
  // effect drawn only once, like a texture rendered when a screen opens, then stays missing)
  g.skipPending = typeof location !== "undefined" && /[?&]skipshaders=1/.test(location.search);
  g.asyncShaders = () => {
    if (g.asyncMode === undefined) g.asyncMode = !(typeof location !== "undefined" && /[?&]syncshaders=1/.test(location.search)) && Module.uewAsyncShaders !== false;
    return g.asyncMode;
  };
  if (features.includes("timestamp-query")) {
    const N = 1024, P = g.prof = {
      N,
      qs: device.createQuerySet({
        type: "timestamp",
        count: N * 2
      }),
      n: 0,
      passes: [],
      cur: null,
      busy: false,
      res: device.createBuffer({
        size: N * 16,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
      }),
      shaders: new Map,
      shown: new Set
    };
    const wrap = enc => {
      const br = enc.beginRenderPass.bind(enc), bc = enc.beginComputePass.bind(enc);
      const stamp = (kind, d) => {
        if (P.n >= N) {
          P.cur = null;
          return d;
        }
        P.cur = {
          kind,
          pipes: new Map,
          draws: 0
        };
        P.passes.push(P.cur);
        const tw = {
          querySet: P.qs,
          beginningOfPassWriteIndex: P.n * 2,
          endOfPassWriteIndex: P.n * 2 + 1
        };
        P.n++;
        return Object.assign({}, d || {}, {
          timestampWrites: tw
        });
      };
      enc.beginRenderPass = d => br(stamp("render", d));
      enc.beginComputePass = d => bc(stamp("compute", d));
      return enc;
    };
    g.encoder = () => g.enc || (g.enc = wrap(device.createCommandEncoder()));
    P.frameEnd = () => {
      if (!P.n) return;
      if (P.busy) {
        P.n = 0;
        P.passes = [];
        return;
      }
      g.endPass();
      const n = P.n, passes = P.passes, enc = g.encoder();
      const out = device.createBuffer({
        size: n * 16,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
      });
      enc.resolveQuerySet(P.qs, 0, n * 2, P.res, 0);
      enc.copyBufferToBuffer(P.res, 0, out, 0, n * 16);
      P.n = 0;
      P.passes = [];
      P.busy = true;
      const frame = g.frames;
      setTimeout(() => out.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigInt64Array(out.getMappedRange());
        const ms = [];
        let total = 0;
        for (let i = 0; i < n; i++) {
          const v = Number(t[2 * i + 1] - t[2 * i]) / 1e6;
          ms.push(v > 0 && v < 1e4 ? v : 0);
          total += ms[i];
        }
        out.unmap();
        out.destroy();
        P.busy = false;
        if (total < 12) return;
        const top = ms.map((v, i) => [ v, i ]).sort((a, b) => b[0] - a[0]).slice(0, 5);
        console.log(`[gpuprof] frame ${frame}: ${total.toFixed(1)} ms GPU in ${n} passes; slowest: ` + top.map(([v, i]) => {
          const ps = passes[i], pp = [ ...ps.pipes ].sort((a, b) => b[1] - a[1]).slice(0, 3);
          return `#${i} ${ps.kind} ${v.toFixed(1)} ms ${ps.draws} draws [` + pp.map(([id, c]) => {
            const pl = g.o[id] || {};
            return `pipe ${id} vs ${pl.__vs} ps ${pl.__ps} x${c}`;
          }).join(", ") + "]";
        }).join(" | "));
        // the pixel shader behind the worst pass, once
        const worst = passes[top[0][1]];
        if (worst) for (const [id] of worst.pipes) {
          const pl = g.o[id] || {}, sh = pl.__ps || pl.__cs;
          if (sh && !P.shown.has(sh) && P.shown.size < 12 && P.shaders.has(sh)) {
            P.shown.add(sh);
            console.log(`[gpuprof] shader ${sh}:\n${P.shaders.get(sh)}`);
            break;
          }
        }
      }, () => {
        out.destroy();
        P.busy = false;
      }), 0);
    };
  }
  g.endPass = () => {
    if (g.pass) {
      g.pass.end();
      g.pass = null;
    }
  };
  // a command buffer that runs too long on the GPU trips Windows' GPU watchdog (~2 s), and the browser then loses the
  // device for good. Heavy frames (UE's GPU benchmark: hundreds of passes of long shaders) are split into several
  // submissions; an ordinary frame (~50 passes) stays one.
  g.passesInCb = 0;
  g.passLimit = 64;
  g.passBudget = () => {
    if (++g.passesInCb > g.passLimit && g.enc) g.flush(0);
  };
  // only the part of the ring written since the last flush goes up; what is already there stays valid for the frame
  g.ringDone = 0;
  // flushes that do not know the write position (readbacks) read it from the C side: work already recorded may use
  // ring data written since the last upload
  g.flush = used => {
    g.endPass();
    if (!used && Module.uewRingUsedPtr) used = (growMemViews(), HEAPU32)[Module.uewRingUsedPtr / 4 >>> 0];
    used = (used + 3) & ~3;
    if (used < g.ringDone) g.ringDone = 0;
    if (used > g.ringDone) g.queue.writeBuffer(g.ring, g.ringDone, (growMemViews(), 
    HEAPU8), g.ringPtr + g.ringDone, used - g.ringDone);
    g.ringDone = used;
    if (g.enc) {
      g.queue.submit([ g.enc.finish() ]);
      g.enc = null;
    }
    g.passesInCb = 0;
    g.queuedBytes = 0;
  };
  g.dummy = key => {
    let x = g.dummies.get(key);
    if (x) return x;
    const [dim, type] = key.split(":");
    if (key === "buf" || key === "sbuf") x = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.STORAGE
    }); else if (key === "stex") x = device.createTexture({
      size: [ 1, 1 ],
      format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING
    }).createView(); else {
      const fmt = type === "depth" ? "depth32float" : type === "sint" ? "rgba8sint" : type === "uint" ? "rgba8uint" : "rgba8unorm";
      const layers = dim.startsWith("cube") ? 6 : 1;
      const tdim = dim === "1d" ? "1d" : dim === "3d" ? "3d" : "2d";
      x = device.createTexture({
        size: [ 1, 1, layers ],
        dimension: tdim,
        format: fmt,
        usage: GPUTextureUsage.TEXTURE_BINDING
      }).createView({
        dimension: dim
      });
    }
    g.dummies.set(key, x);
    return x;
  };
  g.emptyLayout = device.createBindGroupLayout({
    entries: []
  });
  g.zeroVB = () => g.zvb || (g.zvb = device.createBuffer({
    size: 65536,
    usage: GPUBufferUsage.VERTEX
  }));
  // a bad call is logged and skipped rather than stopping the game
  g.fail = (what, e) => g.guard(what, () => {
    throw e;
  });
  g.guard = (what, fn) => {
    try {
      fn();
    } catch (e) {
      g.skip.threw++;
      g.skip.last = `${what}: ${e.message} @ ${(e.stack || "").split("\n").slice(1, 3).join(" < ")}`;
      if (g.errors++ < 40) console.log(`[webgpu] ${what}: ${e.message}`);
    }
  };
  g.skip = {
    nopass: 0,
    nopipe: 0,
    threw: 0,
    last: ""
  };
  g.hitch = {
    last: 0,
    tex: 0,
    texPx: 0,
    upBytes: 0,
    sh: 0,
    pipe: 0,
    psh: 0,
    ppipe: 0,
    rb: 0,
    bytes: 0,
    req: 0,
    fms: 0,
    logged: 0
  };
  // debug: window.uewCaptureFrame = N reads back every render target of frame N into Module.uewgCaptured
  g.capFrame = (typeof window != "undefined" && window.uewCaptureFrame) | 0;
  g.cap = null;
  g.capEvent = e => {
    if (g.cap && g.cap.events.length < 4e3) g.cap.events.push(e);
  };
  g.capTarget = (att, aspect) => {
    const v = att && att.view, t = v && v.__tex;
    if (!t || g.cap.reads.length >= 400) return null;
    const bpp = {
      "rgba8unorm": 4,
      "rgba8unorm-srgb": 4,
      "bgra8unorm": 4,
      "bgra8unorm-srgb": 4,
      "rgb10a2unorm": 4,
      "rg11b10ufloat": 4,
      "r32float": 4,
      "rg32float": 8,
      "rgba32float": 16,
      "rgba16float": 8,
      "rg16float": 4,
      "r16float": 2,
      "r8unorm": 1,
      "rg8unorm": 2,
      "depth32float": 4,
      "depth32float-stencil8": 4
    }[t.format];
    if (!bpp || t.dimension !== "2d") return null;
    const mip = v.__mip || 0, w = Math.max(1, t.width >> mip), h = Math.max(1, t.height >> mip), bpr = (w * bpp + 255) & ~255;
    const buf = device.createBuffer({
      size: bpr * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    const src = {
      texture: t,
      mipLevel: mip,
      origin: [ 0, 0, v.__layer || 0 ]
    };
    if (aspect) src.aspect = aspect;
    g.encoder().copyTextureToBuffer(src, {
      buffer: buf,
      bytesPerRow: bpr,
      rowsPerImage: h
    }, [ w, h, 1 ]);
    const r = {
      buf,
      w,
      h,
      bpr,
      fmt: t.format,
      tex: t.__id,
      mip,
      layer: v.__layer || 0
    };
    g.cap.reads.push(r);
    return g.cap.reads.length - 1;
  };
  // clears wait for the next pass and become its load operation; anything else runs them first
  g.pendClears = [];
  g.flushClears = () => {
    for (const d of g.pendClears) {
      const colorAttachments = d.color.filter(c => c).map(c => (({
        view: c.view,
        loadOp: "clear",
        storeOp: "store",
        clearValue: c.clear,
        depthSlice: c.slice >= 0 ? c.slice : undefined
      })));
      let depthStencilAttachment;
      if (d.depth) {
        const z = d.depth;
        depthStencilAttachment = {
          view: z.view,
          depthLoadOp: z.dclear !== undefined ? "clear" : "load",
          depthStoreOp: "store",
          depthClearValue: z.dclear ?? 1
        };
        if (z.stencil) Object.assign(depthStencilAttachment, {
          stencilLoadOp: z.sclear !== undefined ? "clear" : "load",
          stencilStoreOp: "store",
          stencilClearValue: z.sclear ?? 0
        });
      }
      if (colorAttachments.length || depthStencilAttachment) g.encoder().beginRenderPass({
        colorAttachments,
        depthStencilAttachment
      }).end();
    }
    g.pendClears.length = 0;
  };
  g.endPass = keepClears => {
    if (g.pass) {
      g.pass.end();
      g.pass = null;
      if (g.cap && g.cap.cur) {
        const c = g.cap.cur;
        g.cap.cur = null;
        c.reads = c.desc.colorAttachments.map(a => a ? g.capTarget(a) : null);
        if (c.desc.depthStencilAttachment) c.reads.push(g.capTarget(c.desc.depthStencilAttachment, "depth-only"));
        delete c.desc;
        g.capEvent(c);
      }
    }
    if (!keepClears && g.pendClears.length) g.flushClears();
  };
  g.capFinish = async cap => {
    const half = u => {
      const e = (u >> 10) & 31, m = u & 1023, s = u & 32768 ? -1 : 1;
      return e === 0 ? s * m * 5.96e-8 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * Math.pow(2, e - 15);
    };
    const uf = (v, mb) => {
      const e = v >> mb, m = v & ((1 << mb) - 1);
      return e === 0 ? m / (1 << mb) * Math.pow(2, -14) : e === 31 ? Infinity : (1 + m / (1 << mb)) * Math.pow(2, e - 15);
    };
    const out = [];
    for (const r of cap.reads) {
      await r.buf.mapAsync(GPUMapMode.READ);
      const raw = new Uint8Array(r.buf.getMappedRange().slice(0));
      r.buf.unmap();
      r.buf.destroy();
      const dv = new DataView(raw.buffer), px = new Float32Array(r.w * r.h * 4);
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
        const o = y * r.bpr, k = (y * r.w + x) * 4;
        let c = [ 0, 0, 0, 1 ];
        switch (r.fmt) {
         case "rgba8unorm":
         case "rgba8unorm-srgb":
          {
            const q = o + x * 4;
            c = [ raw[q] / 255, raw[q + 1] / 255, raw[q + 2] / 255, raw[q + 3] / 255 ];
            break;
          }

         case "bgra8unorm":
         case "bgra8unorm-srgb":
          {
            const q = o + x * 4;
            c = [ raw[q + 2] / 255, raw[q + 1] / 255, raw[q] / 255, raw[q + 3] / 255 ];
            break;
          }

         case "rgb10a2unorm":
          {
            const u = dv.getUint32(o + x * 4, true);
            c = [ (u & 1023) / 1023, ((u >> 10) & 1023) / 1023, ((u >> 20) & 1023) / 1023, (u >>> 30) / 3 ];
            break;
          }

         case "rg11b10ufloat":
          {
            const u = dv.getUint32(o + x * 4, true);
            c = [ uf(u & 2047, 6), uf((u >> 11) & 2047, 6), uf(u >>> 22, 5), 1 ];
            break;
          }

         case "r32float":
         case "depth32float":
         case "depth32float-stencil8":
          {
            const f = dv.getFloat32(o + x * 4, true);
            c = [ f, f, f, 1 ];
            break;
          }

         case "rg32float":
          c = [ dv.getFloat32(o + x * 8, true), dv.getFloat32(o + x * 8 + 4, true), 0, 1 ];
          break;

         case "rgba32float":
          for (let j = 0; j < 4; j++) c[j] = dv.getFloat32(o + x * 16 + j * 4, true);
          break;

         case "rgba16float":
          for (let j = 0; j < 4; j++) c[j] = half(dv.getUint16(o + x * 8 + j * 2, true));
          break;

         case "rg16float":
          c = [ half(dv.getUint16(o + x * 4, true)), half(dv.getUint16(o + x * 4 + 2, true)), 0, 1 ];
          break;

         case "r16float":
          {
            const f = half(dv.getUint16(o + x * 2, true));
            c = [ f, f, f, 1 ];
            break;
          }

         case "r8unorm":
          {
            const f = raw[o + x] / 255;
            c = [ f, f, f, 1 ];
            break;
          }

         case "rg8unorm":
          c = [ raw[o + x * 2] / 255, raw[o + x * 2 + 1] / 255, 0, 1 ];
          break;
        }
        px.set(c, k);
      }
      const mn = [ Infinity, Infinity, Infinity, Infinity ], mx = [ -Infinity, -Infinity, -Infinity, -Infinity ], sum = [ 0, 0, 0, 0 ];
      let bad = 0, neg = 0, huge = 0;
      const mask = new Uint8Array(r.w * r.h);
      for (let i = 0; i < px.length; i++) {
        const v = px[i], j = i & 3;
        if (!isFinite(v)) {
          bad++;
          mask[i >> 2] = 3;
          continue;
        }
        if (v < mn[j]) mn[j] = v;
        if (v > mx[j]) mx[j] = v;
        sum[j] += v;
        if (j < 3 && v < 0) {
          neg++;
          mask[i >> 2] |= 1;
        }
        if (j < 3 && v > 1e3) {
          huge++;
          mask[i >> 2] |= 2;
        }
      }
      let maskPng = null;
      if (neg || huge || bad) {
        const mc = document.createElement("canvas");
        mc.width = r.w;
        mc.height = r.h;
        const m2 = mc.getContext("2d"), mi = m2.createImageData(r.w, r.h);
        for (let i = 0; i < r.w * r.h; i++) {
          mi.data[i * 4] = mask[i] & 2 ? 255 : 0;
          mi.data[i * 4 + 2] = mask[i] & 1 ? 255 : 0;
          mi.data[i * 4 + 1] = mask[i] === 3 ? 255 : 0;
          mi.data[i * 4 + 3] = 255;
        }
        m2.putImageData(mi, 0, 0);
        maskPng = mc.toDataURL("image/png");
      }
      const depth = r.fmt.startsWith("depth");
      const cv = document.createElement("canvas");
      cv.width = r.w;
      cv.height = r.h;
      const c2 = cv.getContext("2d"), img = c2.createImageData(r.w, r.h);
      for (let i = 0; i < r.w * r.h; i++) for (let j = 0; j < 4; j++) {
        let v = px[i * 4 + j];
        if (!isFinite(v)) v = j === 0 ? 1 : 0; else if (j < 3) v = depth ? (v - mn[0]) / Math.max(1e-9, mx[0] - mn[0]) : v / (1 + Math.max(0, v - 1));
        img.data[i * 4 + j] = j === 3 ? 255 : Math.max(0, Math.min(255, v * 255));
      }
      c2.putImageData(img, 0, 0);
      const n = r.w * r.h;
      // HDR float targets: also an exposure-normalised copy (mean luminance -> 0.18) so dark scene colour is readable
      let hdrPng = null;
      if (/float/.test(r.fmt) && !depth) {
        const lum = (sum[0] + sum[1] + sum[2]) / (3 * n), k = lum > 0 ? .18 / lum : 1;
        const img2 = c2.createImageData(r.w, r.h);
        for (let i = 0; i < n; i++) for (let j = 0; j < 4; j++) {
          let v = px[i * 4 + j] * (j < 3 ? k : 1);
          if (!isFinite(v)) v = 0;
          if (j < 3) v = Math.pow(v / (1 + v), 1 / 2.2);
          img2.data[i * 4 + j] = j === 3 ? 255 : Math.max(0, Math.min(255, v * 255));
        }
        const cv2 = document.createElement("canvas");
        cv2.width = r.w;
        cv2.height = r.h;
        cv2.getContext("2d").putImageData(img2, 0, 0);
        hdrPng = cv2.toDataURL("image/png");
      }
      out.push({
        fmt: r.fmt,
        w: r.w,
        h: r.h,
        tex: r.tex,
        mip: r.mip,
        layer: r.layer,
        min: mn,
        max: mx,
        mean: sum.map(s => s / n),
        nonfinite: bad,
        neg,
        huge,
        mask: maskPng,
        hdr: hdrPng,
        png: cv.toDataURL("image/png")
      });
    }
    // raw mip 0 of textures asked for by id (compressed ones too), base64
    const raw = {};
    let want = window.uewCaptureTex || [];
    if (want === "auto") {
      want = new Set;
      for (const e of cap.events) if (e.draws && e.draws.length >= 20) for (const r of (e.draws[0].res[3] || []).slice(0, 4)) if (typeof r === "number") want.add(r);
      for (const e of cap.events) for (const d of e.draws || []) for (const grp of d.res || []) for (const r of grp || []) if (typeof r === "number" && g.o[r] instanceof GPUTexture && g.o[r].depthOrArrayLayers === 6) want.add(r);
    }
    const items = [];
    for (const id of want) {
      const t = g.o[id];
      if (!(t instanceof GPUTexture)) continue;
      const mips = t.depthOrArrayLayers === 6 ? t.mipLevelCount : 1;
      for (let m = 0; m < mips; m++) items.push([ id, m ]);
    }
    for (const [id, mip] of items) {
      const t = g.o[id];
      if (!(t instanceof GPUTexture) || t.dimension !== "2d") continue;
      const bc = /^bc/.test(t.format), blk = bc ? (/^bc[14]/.test(t.format) ? 8 : 16) : 0;
      const bpp = {
        "rgba8unorm": 4,
        "rgba8unorm-srgb": 4,
        "bgra8unorm": 4,
        "rgba16float": 8,
        "r8unorm": 1,
        "rg8unorm": 2,
        "r16float": 2,
        "rgba32float": 16
      }[t.format];
      if (!bc && !bpp) {
        raw[id] = {
          fmt: t.format
        };
        continue;
      }
      const tw = Math.max(1, t.width >> mip), th = Math.max(1, t.height >> mip);
      const bw = bc ? (tw + 3) >> 2 : tw, bh = bc ? (th + 3) >> 2 : th, rowb = bw * (bc ? blk : bpp), bpr = (rowb + 255) & ~255;
      const L = Math.min(t.depthOrArrayLayers, 6);
      const buf = device.createBuffer({
        size: bpr * bh * L,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      const e = device.createCommandEncoder();
      e.copyTextureToBuffer({
        texture: t,
        mipLevel: mip
      }, {
        buffer: buf,
        bytesPerRow: bpr,
        rowsPerImage: bh
      }, [ bc ? bw * 4 : tw, bc ? bh * 4 : th, L ]);
      g.queue.submit([ e.finish() ]);
      await buf.mapAsync(GPUMapMode.READ);
      const src = new Uint8Array(buf.getMappedRange()), dst = new Uint8Array(rowb * bh * L);
      for (let y = 0; y < bh * L; y++) dst.set(src.subarray(y * bpr, y * bpr + rowb), y * rowb);
      buf.unmap();
      buf.destroy();
      let bin = "";
      for (let i = 0; i < dst.length; i += 32768) bin += String.fromCharCode.apply(null, dst.subarray(i, i + 32768));
      raw[mip ? `${id}m${mip}` : id] = {
        fmt: t.format,
        w: tw,
        h: th * L,
        data: btoa(bin)
      };
    }
    // debug: window.uewCaptureBuf dumps the buffers the first depth-only and first multi-target draws read (base64)
    const bufs = {};
    if (window.uewCaptureBuf) {
      const pick = [];
      for (const e of cap.events) for (const d of e.draws || []) {
        const nt = (d.targets || []).length;
        if (!pick.some(p => p.k === "depth") && !nt && d.depth && d.depth.depthWriteEnabled) pick.push({
          k: "depth",
          d
        });
        if (!pick.some(p => p.k === "base") && nt >= 4) pick.push({
          k: "base",
          d
        });
      }
      for (const e of cap.events) {
        const d = (e.draws || []).find(d => d.count === -1);
        if (d) {
          pick.push({
            k: "indirect",
            d: {
              res: [ [ `b${d.instances}@0+0` ] ]
            }
          });
          break;
        }
      }
      if (window.uewCaptureBufCount) for (const e of cap.events) for (const d of e.draws || []) if (d.count === window.uewCaptureBufCount) pick.push({
        k: "count",
        d
      });
      for (const p of pick) for (const v of p.d.vbs || []) if (v[0] > 0) p.d.res.push([ `b${v[1]}@0+0` ]);
      for (const p of pick) for (const grp of p.d.res || []) for (const r of grp || []) {
        if (typeof r !== "string" || !/^b\d/.test(r) || bufs[r]) continue;
        const m = /^b(\d+)@(\d+)\+(\d+)$/.exec(r), src = g.o[+m[1]];
        if (!(src instanceof GPUBuffer)) continue;
        const off = +m[2], size = Math.min(+m[3] || (src.size - off), 4 << 20) & ~3;
        const buf = device.createBuffer({
          size,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
        const e = device.createCommandEncoder();
        e.copyBufferToBuffer(src, off, buf, 0, size);
        g.queue.submit([ e.finish() ]);
        await buf.mapAsync(GPUMapMode.READ);
        const u = new Uint8Array(buf.getMappedRange());
        let bin = "";
        for (let i = 0; i < u.length; i += 32768) bin += String.fromCharCode.apply(null, u.subarray(i, i + 32768));
        buf.unmap();
        buf.destroy();
        bufs[r] = btoa(bin);
      }
    }
    const perDraw = [];
    for (const r of cap.perDraw) {
      await r.buf.mapAsync(GPUMapMode.READ);
      const u = new Uint16Array(r.buf.getMappedRange());
      let neg = 0, huge = 0;
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w * 4; x++) {
        if ((x & 3) === 3) continue;
        const v = u[(y * r.bpr >> 1) + x];
        if (v & 32768 && v & 32767) neg++; else if ((v & 32767) > 25552) huge++;
      }
      r.buf.unmap();
      r.buf.destroy();
      perDraw.push({
        pass: r.pass,
        draw: r.draw,
        ps: r.ps,
        tex: r.tex,
        neg,
        huge
      });
    }
    const px = [];
    for (const r of cap.px) {
      await r.buf.mapAsync(GPUMapMode.READ);
      const dv = new DataView(r.buf.getMappedRange());
      const h2f = u => {
        const e = (u >> 10) & 31, m = u & 1023, sg = u & 32768 ? -1 : 1;
        return e === 0 ? sg * m * 5.96e-8 : e === 31 ? NaN : sg * (1 + m / 1024) * Math.pow(2, e - 15);
      };
      for (const [x, y] of window.uewCapturePixels) {
        if (x >= r.w || y >= r.h) continue;
        const o = y * r.bpr + x * r.bpp;
        const val = r.kind === "z" ? [ dv.getFloat32(o, true) ] : [ 0, 2, 4, 6 ].map(k => +h2f(dv.getUint16(o + k, true)).toPrecision(5));
        px.push({
          kind: r.kind,
          x,
          y,
          pass: r.pass,
          draw: r.draw,
          ps: r.ps,
          vs: r.vs,
          n: r.n,
          first: r.first,
          val
        });
      }
      r.buf.unmap();
      r.buf.destroy();
    }
    Module.uewgCaptured = {
      events: cap.events,
      images: out,
      shaders: g.capShaders,
      raw,
      perDraw,
      px,
      bufs
    };
    console.log(`[webgpu] captured frame ${g.frames}: ${cap.events.length} events, ${out.length} targets`);
  };
  g.capShaders = {};
  g.stat = {
    pass: 0,
    reopen: 0,
    write: 0,
    writeBytes: 0,
    ringCopy: 0,
    texWrite: 0,
    bg: 0,
    draws: 0
  };
  g.openPass = () => {
    g.stat.pass++;
    g.pass = g.encoder().beginRenderPass(g.lastPass);
    if (g.cap) g.cap.cur = {
      pass: g.cap.events.length,
      desc: g.lastPass,
      draws: []
    };
  };
  const ai = adapter.info || {};
  console.log(`[webgpu] GPU: ${[ ai.vendor, ai.architecture, ai.description ].filter(x => x).join(" / ") || "not reported"}${ai.isFallbackAdapter ? " (software fallback!)" : ""}; features: ${features.join(" ")}`);
  // integrated GPUs run the same passes several times slower: shorter submissions keep each well inside the watchdog
  if (/intel|integrated/i.test(`${ai.vendor} ${ai.architecture} ${ai.description}`)) {
    g.passLimit = 16;
    g.queueLimit = 8 << 20;
    console.log("[webgpu] this may be the integrated GPU: Windows Settings > System > Display > Graphics, set your browser to High performance");
  }
  // bit 1: 24-bit depth can be stored as 32-bit float (more precise, and readable by copies)
  return 1 | (g.features.has("depth32float-stencil8") ? 2 : 0);
}

_uewg_init.isAsync = true;

var _uewg_layout_create = function(jsonPtr) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(90, 0, 1, jsonPtr);
  jsonPtr >>>= 0;
  const g = Module.uewg;
  const groups = JSON.parse(UTF8ToString(jsonPtr));
  const bgls = groups.map(entries => entries.length ? g.device.createBindGroupLayout({
    entries
  }) : g.emptyLayout);
  return g.add({
    pl: g.device.createPipelineLayout({
      bindGroupLayouts: bgls
    }),
    bgls
  });
};

function _uewg_max_dynamic_ubo() {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(91, 0, 1);
  return Module.uewg.device.limits.maxDynamicUniformBuffersPerPipelineLayout;
}

function _uewg_max_storage() {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(92, 0, 1);
  return Module.uewg.device.limits.maxStorageBuffersPerShaderStage;
}

function _uewg_pipe_ready(id) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(93, 0, 1, id);
  const g = Module.uewg;
  return g.skipPending || !g.pending.has(id) ? 1 : 0;
}

function _uewg_present(view, ringUsed) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(94, 0, 1, view, ringUsed);
  const g = Module.uewg;
  Module.uewPresents = (Module.uewPresents || 0) + 1;
  if (g.prof) g.prof.frameEnd();
  // long frames: what happened in them (new shaders and pipelines, file downloads)
  const now = performance.now(), h = g.hitch, F = Module.uewFiles || {};
  const dt = h.last ? now - h.last : 0, prev = h.avg || dt;
  if (h.last) h.avg = h.avg ? h.avg * .9 + dt * .1 : dt;
  // a hitch: over 100 ms and well over the recent frames (a slow device's every frame isn't one)
  if (h.last && dt > 100 && dt > 2.5 * prev && g.frames > 60 && h.logged < 300) {
    h.logged++;
    console.log(`[hitch] ${(now - h.last).toFixed(0)} ms frame: ${h.sh + h.psh} new shaders, ${h.pipe + h.ppipe} new pipelines (this frame and the one before), ${h.rb} GPU readbacks, ` + `${(((F.fetched || 0) - h.bytes) / 1048576).toFixed(1)} MB in ${(F.requests || 0) - h.req} downloads (${((F.fetchMs || 0) - h.fms).toFixed(0)} ms waiting)`);
  }
  h.last = now;
  h.psh = h.sh;
  h.ppipe = h.pipe;
  h.sh = 0;
  h.pipe = 0;
  h.rb = 0;
  h.bytes = F.fetched || 0;
  h.req = F.requests || 0;
  h.fms = F.fetchMs || 0;
  g.endPass();
  if (!g.blit) {
    const code = `@group(0) @binding(0) var t: texture_2d<f32>; @group(0) @binding(1) var s: sampler;\n        struct V { @builtin(position) p: vec4<f32>, @location(0) uv: vec2<f32> };\n        @vertex fn vs(@builtin(vertex_index) i: u32) -> V { let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u)); var o: V; o.p = vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0); o.uv = uv; return o; }\n        @fragment fn fs(v: V) -> @location(0) vec4<f32> { return vec4<f32>(textureSampleLevel(t, s, v.uv, 0.0).rgb, 1.0); }`;
    const m = g.device.createShaderModule({
      code
    });
    g.blit = g.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: m,
        entryPoint: "vs"
      },
      fragment: {
        module: m,
        entryPoint: "fs",
        targets: [ {
          format: g.canvasFormat
        } ]
      },
      primitive: {
        topology: "triangle-list"
      }
    });
    g.blitSampler = g.device.createSampler({
      magFilter: "linear",
      minFilter: "linear"
    });
    g.blitGroups = new Map;
  }
  const src = g.o[view];
  if (g.cap) g.capEvent({
    present: view,
    tex: src && src.__tex && src.__tex.__id
  });
  if (src) {
    let bg = g.blitGroups.get(src);
    if (!bg) {
      bg = g.device.createBindGroup({
        layout: g.blit.getBindGroupLayout(0),
        entries: [ {
          binding: 0,
          resource: src
        }, {
          binding: 1,
          resource: g.blitSampler
        } ]
      });
      g.blitGroups.set(src, bg);
    }
    const p = g.encoder().beginRenderPass({
      colorAttachments: [ {
        view: g.ctx.getCurrentTexture().createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: [ 0, 0, 0, 1 ]
      } ]
    });
    p.setPipeline(g.blit);
    p.setBindGroup(0, bg);
    p.draw(3);
    p.end();
  }
  g.flush(ringUsed);
  if (g.expandTmp && g.expandTmp.length) {
    const tmp = g.expandTmp;
    g.expandTmp = [];
    g.queue.onSubmittedWorkDone().then(() => tmp.forEach(b => b.destroy()));
  }
  g.lastPass = null;
  // GPU side of the frame: how long until the queue finished it, and what it was given
  {
    const h = g.hitch, t0 = performance.now(), info = `${h.tex} textures made (${(h.texPx / 1e6).toFixed(1)} Mpx), ${(h.upBytes / 1048576).toFixed(1)} MB uploaded`;
    h.tex = 0;
    h.texPx = 0;
    h.upBytes = 0;
    g.queue.onSubmittedWorkDone().then(() => {
      const ms = performance.now() - t0;
      if (ms > 150 && (h.gpuLogged = (h.gpuLogged || 0) + 1) < 100) console.log(`[hitch] GPU took ${ms.toFixed(0)} ms for a frame: ${info}`);
    });
  }
  g.frames++;
  if (g.capFrame && window.uewCaptureFrame) g.capFrame = window.uewCaptureFrame | 0;
  if (g.cap && g.frames === g.capFrame) {
    const c = g.cap;
    g.cap = null;
    g.capFinish(c);
  }
  if (g.capFrame && g.frames === g.capFrame - 1) g.cap = {
    events: [],
    reads: [],
    cur: null,
    perDraw: [],
    px: []
  };
  if (g.frames === 1 || g.frames % 600 === 0) {
    const s = g.skip;
    console.log(`[webgpu] frame ${g.frames} (${g.draws} draws so far; skipped: ${s.nopass} no pass, ${s.nopipe} no pipeline, ${s.threw} threw${s.last ? " — " + s.last : ""})`);
    g.skip = {
      nopass: 0,
      nopipe: 0,
      threw: 0,
      last: ""
    };
    const top = [ ...g.errKinds ].sort((a, b) => b[1] - a[1]).slice(0, 6);
    for (const [k, n] of top) console.log(`[webgpu]   ${n} x ${k}`);
    g.errKinds.clear();
    const st = g.stat, f = g.frames === 1 ? 1 : 600;
    if (Module.uewgStats || (typeof window != "undefined" && window.uewStats)) if (st.by) console.log("[webgpu] biggest writers (id: bytes/frame, buffer size, last offset): " + [ ...st.by ].sort((a, b) => b[1][0] - a[1][0]).slice(0, 5).map(([k, v]) => `${k}: ${(v[0] / f / 1024).toFixed(0)} KiB of ${(v[1] / 1024).toFixed(0)} KiB @${v[2]}`).join(", "));
    console.log(`[webgpu] per frame: ${(st.pass / f).toFixed(1)} passes (${(st.reopen / f).toFixed(1)} reopened), ${(st.write / f).toFixed(1)} buffer writes (${(st.writeBytes / f / 1024).toFixed(0)} KiB), ${(st.ringCopy / f).toFixed(1)} ring copies, ${(st.texWrite / f).toFixed(1)} texture uploads, ${(st.bg / f).toFixed(1)} bind groups made, ${(st.draws / f).toFixed(0)} draws`);
    g.stat = {
      pass: 0,
      reopen: 0,
      write: 0,
      writeBytes: 0,
      ringCopy: 0,
      texWrite: 0,
      bg: 0,
      draws: 0,
      by: (Module.uewgStats || (typeof window != "undefined" && window.uewStats)) ? new Map : null
    };
  }
}

function _uewg_readback_done(n) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(95, 0, 1, n);
  const t = Module.uewg.rb && Module.uewg.rb.get(n);
  return !t || t.done ? 1 : 0;
}

function _uewg_readback_finish(n) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(96, 0, 1, n);
  const g = Module.uewg, t = g.rb && g.rb.get(n);
  if (!t) return;
  g.rb.delete(n);
  if (t.ok) {
    const data = new Uint8Array(t.tmp.getMappedRange());
    if (!t.kind) (growMemViews(), HEAPU8).set(data.subarray(0, t.w), t.ptr >>> 0); else for (let z = 0; z < t.d; z++) for (let y = 0; y < t.rows; y++) (growMemViews(), 
    HEAPU8).set(data.subarray((z * t.rows + y) * t.bpr, (z * t.rows + y) * t.bpr + Math.min(t.rowbytes, t.pitch)), t.ptr + z * t.slice + y * t.pitch >>> 0);
    t.tmp.unmap();
  }
  t.tmp.destroy();
}

function _uewg_readback_latest(kind, id, mip, layer, w, h, d, ptr, pitch, slice, rowbytes, rows) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(97, 0, 1, kind, id, mip, layer, w, h, d, ptr, pitch, slice, rowbytes, rows);
  ptr >>>= 0;
  const g = Module.uewg, src = g.o[id];
  if (!src || (typeof location !== "undefined" && /[?&]syncreadback=1/.test(location.search))) return 0;
  g.rbl = g.rbl || new Map;
  const k = id + ":" + mip + ":" + layer;
  let e = g.rbl.get(k);
  if (!e) {
    e = {
      busy: false,
      data: null
    };
    g.rbl.set(k, e);
  }
  let got = 0;
  if (e.data) {
    const bpr = kind ? (rowbytes + 255) & ~255 : 0;
    if (!kind) (growMemViews(), HEAPU8).set(e.data.subarray(0, w), ptr >>> 0); else for (let z = 0; z < d; z++) for (let y = 0; y < rows; y++) (growMemViews(), 
    HEAPU8).set(e.data.subarray((z * rows + y) * bpr, (z * rows + y) * bpr + Math.min(rowbytes, pitch)), ptr + z * slice + y * pitch >>> 0);
    got = 1;
  }
  if (!e.busy) {
    g.flush(0);
    const bpr = kind ? (rowbytes + 255) & ~255 : 0, size = kind ? bpr * rows * d : (w + 3) & ~3;
    const tmp = g.device.createBuffer({
      size: Math.max(4, size),
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
    const enc = g.device.createCommandEncoder();
    try {
      if (kind) enc.copyTextureToBuffer({
        texture: src,
        mipLevel: mip,
        origin: [ 0, 0, layer ]
      }, {
        buffer: tmp,
        bytesPerRow: bpr,
        rowsPerImage: rows
      }, [ w, h, d ]); else enc.copyBufferToBuffer(src, 0, tmp, 0, Math.min(size, src.size));
      g.queue.submit([ enc.finish() ]);
    } catch (err) {
      tmp.destroy();
      return got;
    }
    e.busy = true;
    tmp.mapAsync(GPUMapMode.READ).then(() => {
      e.data = new Uint8Array(tmp.getMappedRange()).slice();
      tmp.unmap();
      tmp.destroy();
      e.busy = false;
    }, () => {
      tmp.destroy();
      e.busy = false;
    });
  }
  return got;
}

function _uewg_readback_start(kind, id, mip, layer, w, h, d, ptr, pitch, slice, rowbytes, rows) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(98, 0, 1, kind, id, mip, layer, w, h, d, ptr, pitch, slice, rowbytes, rows);
  ptr >>>= 0;
  const g = Module.uewg, src = g.o[id];
  if (!src) return 0;
  g.flush(0);
  const bpr = kind ? (rowbytes + 255) & ~255 : 0, size = kind ? bpr * rows * d : (w + 3) & ~3;
  const tmp = g.device.createBuffer({
    size: Math.max(4, size),
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
  });
  const enc = g.device.createCommandEncoder();
  try {
    if (kind) enc.copyTextureToBuffer({
      texture: src,
      mipLevel: mip,
      origin: [ 0, 0, layer ]
    }, {
      buffer: tmp,
      bytesPerRow: bpr,
      rowsPerImage: rows
    }, [ w, h, d ]); else enc.copyBufferToBuffer(src, 0, tmp, 0, Math.min(size, src.size));
    g.queue.submit([ enc.finish() ]);
  } catch (e) {
    if (g.errors++ < 40) console.log("[webgpu] readback " + e.message);
    tmp.destroy();
    return 0;
  }
  g.hitch.rb++;
  const t = {
    kind,
    w,
    d,
    rows,
    bpr,
    rowbytes,
    ptr,
    pitch,
    slice,
    tmp,
    done: false,
    ok: false
  };
  const t0 = performance.now();
  tmp.mapAsync(GPUMapMode.READ).then(() => {
    t.ok = true;
    t.done = true;
    Module.uewWake && Module.uewWake();
    const ms = performance.now() - t0;
    if (ms > 50 && (g.rbSlow = (g.rbSlow || 0) + 1) < 60) console.log(`[readback] ${kind ? "texture" : "buffer"} ${w}x${h}x${d} (${size} bytes, ${src.format || ""}) took ${ms.toFixed(0)} ms`);
  }, e => {
    if (g.errors++ < 40) console.log("[webgpu] readback " + e.message);
    t.done = true;
  });
  g.rb = g.rb || new Map;
  g.rbN = (g.rbN || 0) + 1;
  g.rb.set(g.rbN, t);
  return g.rbN;
}

function _uewg_release(id) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(99, 0, 1, id);
  const g = Module.uewg, x = g.o[id];
  if (!x) return;
  if (x instanceof GPUBuffer || x instanceof GPUTexture) x.destroy();
  g.o[id] = null;
  if (g.pst) g.pst.pass = null;
  g.free.push(id);
}

function _uewg_render_pipeline_create(jsonPtr) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(100, 0, 1, jsonPtr);
  jsonPtr >>>= 0;
  const g = Module.uewg;
  const d = JSON.parse(UTF8ToString(jsonPtr));
  if (Module.uewgDebug) console.log("[webgpu] pipeline " + UTF8ToString(jsonPtr));
  g.hitch.pipe++;
  if (window.uewLogCreates) console.log(`[create] pipeline vs ${d.vs} ps ${d.ps}`);
  const desc = {
    layout: g.o[d.layout].pl,
    vertex: {
      module: g.o[d.vs],
      entryPoint: "main",
      buffers: d.buffers
    },
    fragment: d.ps ? {
      module: g.o[d.ps],
      entryPoint: "main",
      targets: d.targets
    } : undefined,
    primitive: d.primitive,
    depthStencil: d.depth,
    multisample: {
      mask: d.sampleMask >>> 0
    }
  };
  const done = p => {
    if (g.capFrame) p.__d = d;
    p.__vs = d.vs;
    p.__ps = d.ps;
    return p;
  };
  if (g.asyncShaders()) {
    // compiled on the browser's worker threads; draws that need it are skipped until it is ready
    const id = g.add(null);
    g.pendingPipes++;
    g.pending.add(id);
    g.device.createRenderPipelineAsync(desc).then(p => {
      g.o[id] = done(p);
      g.pendingPipes--;
      g.pending.delete(id);
      Module.uewWake && Module.uewWake();
    }, e => {
      g.pendingPipes--;
      g.pending.delete(id);
      Module.uewWake && Module.uewWake();
      if (g.errors++ < 40) console.log("[webgpu] pipeline " + e.message);
    });
    return id;
  }
  try {
    return g.add(done(g.device.createRenderPipeline(desc)));
  } catch (e) {
    if (g.errors++ < 40) console.log("[webgpu] pipeline " + e.message);
    return 0;
  }
}

function _uewg_retire(id) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(101, 0, 1, id);
  const g = Module.uewg, x = g.o[id];
  if (!x) return;
  if (x instanceof GPUBuffer || x instanceof GPUTexture) x.destroy();
  g.o[id] = null;
  if (g.pst) g.pst.pass = null;
  if (g.rbl && g.rbl.size) for (const k of g.rbl.keys()) if (k.startsWith(id + ":")) g.rbl.delete(k);
}

function _uewg_ring_reset() {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(102, 0, 1);
  Module.uewg.ringDone = 0;
}

function _uewg_ring_used_at(p) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(103, 0, 1, p);
  p >>>= 0;
  Module.uewRingUsedPtr = p;
}

function _uewg_sampler_create(jsonPtr) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(104, 0, 1, jsonPtr);
  jsonPtr >>>= 0;
  const g = Module.uewg;
  return g.add(g.device.createSampler(JSON.parse(UTF8ToString(jsonPtr))));
}

function _uewg_shader_create(srcPtr) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(105, 0, 1, srcPtr);
  srcPtr >>>= 0;
  const g = Module.uewg;
  let code = UTF8ToString(srcPtr);
  // debug: window.uewShaderPatch(code) may return a replacement source
  if (window.uewShaderPatch) code = window.uewShaderPatch(code) || code;
  g.hitch.sh++;
  if (window.uewLogCreates) console.log(`[create] shader ${code.length} chars`);
  const m = g.device.createShaderModule({
    code
  });
  if (Module.uewgDebug) console.log("[webgpu] shader " + code);
  m.getCompilationInfo().then(info => {
    for (const x of info.messages) if (x.type === "error" && g.errors++ < 40) console.log(`[webgpu] shader ${x.lineNum}:${x.linePos} ${x.message}`);
  });
  const id = g.add(m);
  if (g.capFrame) g.capShaders[id] = code;
  if (g.prof) g.prof.shaders.set(id, code);
  return id;
}

function _uewg_submit(ringUsed) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(106, 0, 1, ringUsed);
  Module.uewg.flush(ringUsed);
}

function _uewg_texture_copy_ring(ringOff, id, mip, x, y, z, w, h, d, bpr, rows) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(107, 0, 1, ringOff, id, mip, x, y, z, w, h, d, bpr, rows);
  const g = Module.uewg, t = g.o[id];
  if (!t) return;
  if (/^(bc|etc2|eac|astc)/.test(t.format)) {
    w = (w + 3) & ~3;
    h = (h + 3) & ~3;
  }
  g.endPass();
  g.stat.texWrite++;
  try {
    g.encoder().copyBufferToTexture({
      buffer: g.ring,
      offset: ringOff,
      bytesPerRow: bpr,
      rowsPerImage: rows
    }, {
      texture: t,
      mipLevel: mip,
      origin: [ x, y, z ]
    }, [ w, h, d ]);
  } catch (e) {
    if (g.errors++ < 40) console.log("[webgpu] ring upload " + e.message);
  }
}

function _uewg_texture_create(jsonPtr) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(108, 0, 1, jsonPtr);
  jsonPtr >>>= 0;
  const g = Module.uewg;
  const d = JSON.parse(UTF8ToString(jsonPtr));
  let usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
  if (d.rt) usage |= GPUTextureUsage.RENDER_ATTACHMENT;
  if (d.uav) usage |= GPUTextureUsage.STORAGE_BINDING;
  try {
    const t = g.device.createTexture({
      size: [ d.w, d.h, d.d ],
      mipLevelCount: d.mips,
      format: d.format,
      dimension: d.dim,
      usage,
      viewFormats: d.viewFormats || []
    });
    g.hitch.tex++;
    g.hitch.texPx += d.w * d.h * d.d;
    const id = g.add(t);
    if (g.capFrame) t.__id = id;
    return id;
  } catch (e) {
    console.log("[webgpu] texture " + d.format + ": " + e.message);
    return 0;
  }
}

function _uewg_texture_write(id, mip, x, y, z, w, h, d, ptr, bpr, rows, size) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(109, 0, 1, id, mip, x, y, z, w, h, d, ptr, bpr, rows, size);
  ptr >>>= 0;
  const g = Module.uewg, t = g.o[id];
  if (!t) return;
  // compressed uploads cover whole blocks, even for mips smaller than one
  if (/^(bc|etc2|eac|astc)/.test(t.format)) {
    w = (w + 3) & ~3;
    h = (h + 3) & ~3;
  }
  g.stat.texWrite++;
  g.hitch.upBytes += bpr * rows * d;
  try {
    g.queue.writeTexture({
      texture: t,
      mipLevel: mip,
      origin: [ x, y, z ]
    }, (growMemViews(), HEAPU8), {
      offset: ptr,
      bytesPerRow: bpr,
      rowsPerImage: rows
    }, [ w, h, d ]);
    g.queued(bpr * rows * d);
  } catch (e) {
    if (g.errors++ < 40) console.log("[webgpu] upload " + e.message);
  }
}

var _uewg_timestamp = function() {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(110, 0, 1);
  const g = Module.uewg;
  const t = g.tsNext = (g.tsNext || 0) + 1;
  (g.ts || (g.ts = new Map)).set(t, -1);
  g.queue.onSubmittedWorkDone().then(() => {
    g.ts.set(t, performance.now());
    Module.uewWake && Module.uewWake();
  }, () => g.ts.set(t, performance.now()));
  if (g.ts.size > 4096) for (const k of g.ts.keys()) {
    if (g.ts.size <= 2048) break;
    g.ts.delete(k);
  }
  return t;
};

function _uewg_timestamp_get(t, out) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(111, 0, 1, t, out);
  out >>>= 0;
  const g = Module.uewg, v = g.ts ? g.ts.get(t) : undefined;
  if (v === undefined) {
    (growMemViews(), HEAPF64)[out / 8 >>> 0] = performance.now();
    return 1;
  }
  if (v < 0) return 0;
  (growMemViews(), HEAPF64)[out / 8 >>> 0] = v;
  return 1;
}

function _uewg_view_create(jsonPtr) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(112, 0, 1, jsonPtr);
  jsonPtr >>>= 0;
  const g = Module.uewg;
  const d = JSON.parse(UTF8ToString(jsonPtr));
  const t = g.o[d.tex];
  if (!t) return 0;
  const desc = {
    dimension: d.dim,
    baseMipLevel: d.mip,
    mipLevelCount: d.mips,
    baseArrayLayer: d.layer,
    arrayLayerCount: d.layers,
    aspect: d.aspect
  };
  if (d.format) desc.format = d.format;
  if (d.swizzle && g.features.has("texture-component-swizzle")) desc.swizzle = d.swizzle;
  try {
    const v = t.createView(desc);
    if (g.capFrame) {
      v.__tex = t;
      v.__mip = d.mip;
      v.__layer = d.layer;
    }
    return g.add(v);
  } catch (e) {
    if (g.errors++ < 40) console.log("[webgpu] view " + e.message);
    return 0;
  }
}

function _web_canvas_h() {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(113, 0, 1);
  const c = Module.canvas || (typeof document !== "undefined" && document.getElementById("canvas"));
  return c ? c.height : 720;
}

function _web_canvas_w() {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(114, 0, 1);
  const c = Module.canvas || (typeof document !== "undefined" && document.getElementById("canvas"));
  return c ? c.width : 1280;
}

function _web_input_init() {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(115, 0, 1);
  if (Module.uewInput) return;
  const q = Module.uewInput = [];
  const canvas = Module.canvas || (typeof document !== "undefined" && document.getElementById("canvas"));
  if (!canvas) return;
  const codes = {
    Escape: 27,
    Tab: 9,
    Enter: 13,
    Space: 32,
    Backspace: 8,
    ShiftLeft: 160,
    ShiftRight: 161,
    ControlLeft: 162,
    ControlRight: 163,
    AltLeft: 164,
    AltRight: 165,
    CapsLock: 20,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Insert: 45,
    Delete: 46,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    Backquote: 192,
    Minus: 189,
    Equal: 187,
    BracketLeft: 219,
    BracketRight: 221,
    Backslash: 220,
    Semicolon: 186,
    Quote: 222,
    Comma: 188,
    Period: 190,
    Slash: 191
  };
  const vk = e => {
    if (codes[e.code]) return codes[e.code];
    if (/^Key[A-Z]$/.test(e.code)) return e.code.charCodeAt(3);
    if (/^Digit[0-9]$/.test(e.code)) return e.code.charCodeAt(5);
    if (/^F([1-9]|1[0-2])$/.test(e.code)) return 111 + parseInt(e.code.slice(1));
    if (/^Numpad[0-9]$/.test(e.code)) return 96 + parseInt(e.code.slice(6));
    return 0;
  };
  const generic = k => k === 160 || k === 161 ? 16 : k === 162 || k === 163 ? 17 : k === 164 || k === 165 ? 18 : 0;
  const key = down => e => {
    const k = vk(e);
    if (!k) return;
    e.preventDefault();
    const g = generic(k);
    if (g) q.push([ down ? 1 : 2, g, 0, 0, 0 ]);
    q.push([ down ? 1 : 2, k, 0, 0, 0 ]);
    if (down && e.key.length === 1) q.push([ 3, e.key.codePointAt(0), 0, 0, 0 ]);
  };
  window.addEventListener("keydown", key(true));
  window.addEventListener("keyup", key(false));
  const pos = e => {
    const r = canvas.getBoundingClientRect();
    return [ Math.round((e.clientX - r.left) * canvas.width / r.width), Math.round((e.clientY - r.top) * canvas.height / r.height) ];
  };
  canvas.addEventListener("mousemove", e => {
    const [x, y] = pos(e);
    q.push([ 4, x, y, e.movementX | 0, e.movementY | 0 ]);
  });
  const btn = [ 0, 2, 1, 3, 4 ];
  canvas.addEventListener("mousedown", e => {
    e.preventDefault();
    q.push([ 5, btn[e.button] ?? 0, 1, 0, 0 ]);
  });
  window.addEventListener("mouseup", e => q.push([ 5, btn[e.button] ?? 0, 0, 0, 0 ]));
  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    q.push([ 6, e.deltaY < 0 ? 1 : -1, 0, 0, 0 ]);
  }, {
    passive: false
  });
  canvas.addEventListener("contextmenu", e => e.preventDefault());
  window.addEventListener("focus", () => q.push([ 8, 1, 0, 0, 0 ]));
  window.addEventListener("blur", () => q.push([ 8, 0, 0, 0, 0 ]));
  // the render size is fixed by the page unless it opts into following the window
  if (Module.uewAutoSize) new ResizeObserver(() => {
    const w = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio)), h = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
    if (w !== canvas.width || h !== canvas.height) {
      canvas.width = w;
      canvas.height = h;
      q.push([ 7, w, h, 0, 0 ]);
    }
  }).observe(canvas);
}

function _web_next_event(out) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(116, 0, 1, out);
  out >>>= 0;
  const q = Module.uewInput;
  if (!q || !q.length) return 0;
  const e = q.shift();
  for (let i = 0; i < 5; i++) (growMemViews(), HEAP32)[out / 4 + i >>> 0] = e[i];
  return 1;
}

function _web_trace_filter() {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(117, 0, 1);
  const s = (typeof window !== "undefined" && window.uewTraceOnly) || "";
  return stringToNewUTF8(s ? "," + s + "," : "");
}

var uewWW = {
  w: null,
  get() {
    if (this.w) return this.w;
    const cfg = Module.uewSteam || {};
    const q = new URLSearchParams(location.search);
    let url = (q.get("webworks") || (cfg.relay ? location.origin : cfg.url) || "http://localhost:3000").trim().replace(/\/+$/, "").replace(/\/api(\/.*)?$/i, "");
    const mode = q.get("steam") || cfg.mode || "webworks";
    this.w = {
      mode,
      url,
      api: url + "/api",
      state: mode === "webworks" || mode === "account" ? 0 : -1,
      me: "0",
      name: "Player",
      token: "",
      lobbies: new Map,
      names: new Map,
      events: [],
      reqs: new Map,
      nextReq: 1,
      packets: new Map,
      peers: new Set,
      chats: new Map,
      ws: null,
      wsQueue: []
    };
    return this.w;
  },
  put(s, buf, cap) {
    if (!buf || cap <= 0) return lengthBytesUTF8(s);
    stringToUTF8(s, buf, cap);
    return Math.min(lengthBytesUTF8(s), cap - 1);
  },
  lobby(w, id) {
    let l = w.lobbies.get(id);
    if (!l) {
      l = {
        id,
        ownerId: "0",
        maxMembers: 0,
        members: [],
        data: {},
        memberData: {},
        joinable: true
      };
      w.lobbies.set(id, l);
    }
    return l;
  },
  absorb(w, s) {
    if (!s || !s.id) return null;
    const l = this.lobby(w, String(s.id));
    l.ownerId = String(s.ownerId || l.ownerId);
    l.maxMembers = s.maxMembers || l.maxMembers;
    if (s.data) l.data = Object.assign({}, s.data);
    if (Array.isArray(s.members) && (s.members.length || !s.remote)) {
      l.members = s.members.map(m => String(m.steamId));
      for (const m of s.members) if (m.name) w.names.set(String(m.steamId), m.name);
    }
    if (s.memberData) l.memberData = JSON.parse(JSON.stringify(s.memberData));
    if (typeof s.joinable === "boolean") l.joinable = s.joinable;
    l.memberCount = s.memberCount != null ? s.memberCount : l.members.length;
    return l;
  },
  async call(w, method, path, body) {
    const opt = {
      method,
      headers: {
        "X-Webworks-Session": w.token
      }
    };
    if (body !== undefined) {
      opt.headers["Content-Type"] = "application/json";
      opt.body = JSON.stringify(body);
    }
    const r = await fetch(w.api + path, opt);
    let j = null;
    try {
      j = await r.json();
    } catch (e) {}
    if (!r.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
    return j || {};
  },
  request(w, fn) {
    const id = w.nextReq++;
    const r = {
      status: 0,
      result: null
    };
    w.reqs.set(id, r);
    if (w.state !== 1) {
      r.status = 2;
      r.error = "no WebWorks server";
      return id;
    }
    fn().then(v => {
      r.result = v;
      r.status = 1;
    }, e => {
      r.error = String(e && e.message || e);
      r.status = 2;
      console.log("[webworks] " + r.error);
    });
    return id;
  },
  fire(w, method, path, body) {
    if (w.state !== 1) return;
    this.call(w, method, path, body).catch(e => console.log("[webworks] " + path + ": " + (e && e.message || e)));
  },
  send(w, msg) {
    const s = JSON.stringify(msg);
    if (w.ws && w.ws.readyState === 1) w.ws.send(s); else w.wsQueue.push(s);
  },
  connect(w) {
    const ws = new WebSocket(w.url.replace(/^http/i, "ws") + "/realtime?session=" + encodeURIComponent(w.token));
    w.ws = ws;
    ws.onopen = () => {
      for (const s of w.wsQueue.splice(0)) ws.send(s);
    };
    ws.onmessage = e => {
      try {
        this.onMessage(w, JSON.parse(e.data));
      } catch (x) {
        console.log("[webworks] bad message: " + x);
      }
    };
    ws.onclose = () => {
      if (w.state === 1) setTimeout(() => this.connect(w), 2e3);
    };
  },
  onMessage(w, m) {
    const id = m.lobbyId != null ? String(m.lobbyId) : "";
    const who = m.steamId != null ? String(m.steamId) : (m.from != null ? String(m.from) : "0");
    if (m.name && who !== "0") w.names.set(who, m.name);
    switch (m.type) {
     case "LobbyMemberJoined":
      {
        const l = this.lobby(w, id);
        if (!l.members.includes(who)) l.members.push(who);
        w.events.push([ 1, id, who ]);
        break;
      }

     case "LobbyMemberLeave":
     case "LobbyMemberDisconnected":
     case "LobbyMemberKicked":
      {
        const l = this.lobby(w, id);
        l.members = l.members.filter(x => x !== who);
        delete l.memberData[who];
        if (m.ownerId) l.ownerId = String(m.ownerId);
        w.events.push([ 2, id, who, m.type === "LobbyMemberLeave" ? "2" : m.type === "LobbyMemberKicked" ? "8" : "4" ]);
        break;
      }

     case "LobbyDataChanged":
      {
        const l = this.lobby(w, id);
        if (m.value === null || m.value === undefined) delete l.data[m.key]; else l.data[m.key] = String(m.value);
        w.events.push([ 3, id, id ]);
        break;
      }

     case "LobbyMemberDataChanged":
      {
        const l = this.lobby(w, id);
        (l.memberData[who] = l.memberData[who] || {})[m.key] = m.value == null ? "" : String(m.value);
        w.events.push([ 3, id, who ]);
        break;
      }

     case "LobbyOwnerChanged":
      this.lobby(w, id).ownerId = String(m.ownerId || who);
      w.events.push([ 3, id, id ]);
      break;

     case "LobbyChat":
      {
        const bytes = Uint8Array.from(atob(m.data || ""), ch => ch.charCodeAt(0));
        w.chats.set(id + ":" + m.chatId, {
          who,
          bytes,
          type: m.entryType || 1
        });
        if (w.chats.size > 256) w.chats.delete(w.chats.keys().next().value);
        w.events.push([ 5, id, who, String(m.chatId) ]);
        break;
      }

     case "GameInvite":
     case "LobbyInvite":
      if (id) w.events.push([ 8, id, who ]);
      break;

     case "P2PPacket":
      {
        const ch = m.channel | 0;
        const bytes = Uint8Array.from(atob(m.data || ""), x => x.charCodeAt(0));
        if (!w.peers.has(who)) {
          w.peers.add(who);
          w.events.push([ 6, who ]);
        }
        let q = w.packets.get(ch);
        if (!q) w.packets.set(ch, q = []);
        q.push([ who, bytes ]);
        if (q.length > 4096) q.shift();
        break;
      }

     case "P2PSessionRequest":
      if (!w.peers.has(who)) {
        w.peers.add(who);
        w.events.push([ 6, who ]);
      }
      break;

     case "P2PConnectionFailed":
      w.events.push([ 7, who, "4" ]);
      break;

     case "PeerDisconnected":
      w.peers.delete(who);
      w.events.push([ 7, who, "2" ]);
      break;

     case "PersonaStateChange":
      w.events.push([ 9, who ]);
      break;
    }
  },
  deviceKey() {
    const k = "uew_webworks_device";
    let v = null;
    try {
      v = localStorage.getItem(k);
    } catch (e) {}
    if (!v || !/^[0-9a-f]{32}$/.test(v)) {
      v = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
      try {
        localStorage.setItem(k, v);
      } catch (e) {}
    }
    return v;
  }
};

function _ww_chat_get(id, chat, buf, cap, who, whocap) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(118, 0, 1, id, chat, buf, cap, who, whocap);
  id >>>= 0;
  buf >>>= 0;
  who >>>= 0;
  const e = uewWW.get().chats.get(UTF8ToString(id) + ":" + chat);
  if (!e) return -1;
  if (who) uewWW.put(e.who, who, whocap);
  const n = Math.min(cap, e.bytes.length);
  (growMemViews(), HEAPU8).set(e.bytes.subarray(0, n), buf >>> 0);
  return n;
}

function _ww_chat_send(id, data, len) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(119, 0, 1, id, data, len);
  id >>>= 0;
  data >>>= 0;
  const w = uewWW.get();
  const b = (growMemViews(), HEAPU8).subarray(data >>> 0, data + len >>> 0);
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
  w.ws && w.ws.readyState === 1 ? uewWW.send(w, {
    type: "LobbyChat",
    lobbyId: UTF8ToString(id),
    data: btoa(s)
  }) : uewWW.fire(w, "POST", "/Matchmaking/ChatSend", {
    lobbyId: UTF8ToString(id),
    data: btoa(s)
  });
  return 1;
}

var _ww_create_lobby = function(type, max) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(120, 0, 1, type, max);
  const w = uewWW.get();
  const vis = [ "private", "friends", "public", "invisible" ][type] || "public";
  return uewWW.request(w, async () => {
    const s = await uewWW.call(w, "POST", "/Matchmaking/CreateLobby", {
      maxMembers: max,
      visibility: vis
    });
    const l = uewWW.absorb(w, s);
    if (vis !== "public") {
      await uewWW.call(w, "POST", "/Matchmaking/LobbyVisibility", {
        lobbyId: l.id,
        mode: vis
      });
    }
    return l.id;
  });
};

function _ww_device(buf, cap) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(121, 0, 1, buf, cap);
  buf >>>= 0;
  return uewWW.put(uewWW.deviceKey(), buf, cap);
}

function _ww_event(buf) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(122, 0, 1, buf);
  buf >>>= 0;
  const e = uewWW.get().events.shift();
  if (!e) return 0;
  for (let i = 1; i < 4; i++) uewWW.put(e[i] !== undefined ? String(e[i]) : "0", buf + 64 * (i - 1), 64);
  return e[0];
}

var _ww_iface_version = function(family, buf, cap) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(123, 0, 1, family, buf, cap);
  family >>>= 0;
  buf >>>= 0;
  const f = UTF8ToString(family);
  const norm = v => v.toLowerCase().replace(/_?interface_?(version|v)/, "").replace(/_+$/, "").replace(/\d+$/, "");
  const v = ((Module.uewSteam || {}).versions || []).find(x => norm(x) === f) || "";
  return uewWW.put(v, buf, cap);
};

var _ww_init = function(appid) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(124, 0, 1, appid);
  const w = uewWW.get();
  if (w.mode !== "webworks" && w.mode !== "account") return 0;
  if (w.started) return 1;
  w.started = true;
  w.appId = String(appid);
  const guest = () => {
    const name = w.account ? w.account.name : new URLSearchParams(location.search).get("name") || undefined;
    fetch(w.api + "/User/GuestSession", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        appId: w.appId,
        deviceKey: uewWW.deviceKey(),
        name,
        steamId: w.account ? w.account.steamid : undefined
      })
    }).then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))).then(j => {
      w.token = j.sessionToken;
      w.me = w.account ? w.account.steamid : String(j.steamId);
      w.name = w.account ? w.account.name : j.name || "Player";
      w.names.set(w.me, w.name);
      w.state = 1;
      console.log("[webworks] signed in to " + w.url + " as " + w.name + " (" + w.me + ")");
      uewWW.connect(w);
    }).catch(e => {
      // no server: a local Steam session (the Steam account's identity, or a lasting one from the device key), so
      // games that need a signed-in user carry on; lobbies and P2P fail as with no connection
      if (w.account) {
        w.me = w.account.steamid;
        w.name = w.account.name;
      } else {
        const acct = parseInt(uewWW.deviceKey().slice(0, 8), 16) & 2147483647;
        w.me = String(76561197960265728n + BigInt(acct));
        w.name = new URLSearchParams(location.search).get("name") || "Player";
      }
      w.names.set(w.me, w.name);
      w.state = 2;
      console.log("[webworks] no server at " + w.url + " (" + (e && e.message || e) + "): local Steam session as " + w.name);
    });
  };
  if (w.mode === "account") uewSCM.start(appid).then(ok => {
    const s = uewSCM.get();
    if (ok) w.account = {
      steamid: String(s.steamid),
      name: s.name || "Player"
    };
    guest();
  }); else guest();
  return 1;
};

var _ww_join_lobby = function(id) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(125, 0, 1, id);
  id >>>= 0;
  const w = uewWW.get(), s = UTF8ToString(id);
  return uewWW.request(w, async () => uewWW.absorb(w, await uewWW.call(w, "POST", "/Matchmaking/JoinLobby", {
    lobbyId: s
  })).id);
};

function _ww_lobby_get(id, member, key, buf, cap) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(126, 0, 1, id, member, key, buf, cap);
  id >>>= 0;
  member >>>= 0;
  key >>>= 0;
  buf >>>= 0;
  const w = uewWW.get(), l = w.lobbies.get(UTF8ToString(id));
  if (!l) return -1;
  const m = member ? UTF8ToString(member) : "", k = UTF8ToString(key);
  const src = m ? (l.memberData[m] || {}) : l.data;
  if (!(k in src)) return -1;
  return uewWW.put(String(src[k]), buf, cap);
}

function _ww_lobby_int(what, id) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(127, 0, 1, what, id);
  id >>>= 0;
  const l = uewWW.get().lobbies.get(UTF8ToString(id));
  if (!l) return what === 3 ? 0 : 0;
  return what === 0 ? (l.members.length || l.memberCount || 0) : what === 1 ? l.maxMembers : what === 2 ? Object.keys(l.data).length : (l.joinable ? 1 : 0);
}

function _ww_lobby_leave(id) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(128, 0, 1, id);
  id >>>= 0;
  const w = uewWW.get(), s = UTF8ToString(id);
  uewWW.fire(w, "POST", "/Matchmaking/LeaveLobby", {
    lobbyId: s
  });
  w.lobbies.delete(s);
}

var _ww_lobby_list = function(json) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(129, 0, 1, json);
  json >>>= 0;
  const w = uewWW.get(), body = JSON.parse(UTF8ToString(json));
  return uewWW.request(w, async () => (await uewWW.call(w, "POST", "/Matchmaking/LobbyList", body)).lobbies.map(s => uewWW.absorb(w, s).id));
};

var _ww_lobby_refresh = function(id) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(130, 0, 1, id);
  id >>>= 0;
  const w = uewWW.get(), s = UTF8ToString(id);
  uewWW.call(w, "GET", "/Matchmaking/Lobby?lobbyId=" + encodeURIComponent(s)).then(j => {
    uewWW.absorb(w, j);
    w.events.push([ 3, s, s ]);
  }, () => w.events.push([ 4, s ]));
  return 1;
};

function _ww_lobby_set(what, id, key, value) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(131, 0, 1, what, id, key, value);
  id >>>= 0;
  key >>>= 0;
  value >>>= 0;
  const w = uewWW.get(), s = UTF8ToString(id), k = UTF8ToString(key), v = value ? UTF8ToString(value) : "";
  const l = uewWW.lobby(w, s);
  if (what === 0) {
    l.data[k] = v;
    uewWW.fire(w, "POST", "/Matchmaking/LobbyData", {
      lobbyId: s,
      key: k,
      value: v
    });
  } else if (what === 1) {
    (l.memberData[w.me] = l.memberData[w.me] || {})[k] = v;
    uewWW.fire(w, "POST", "/Matchmaking/MemberData", {
      lobbyId: s,
      key: k,
      value: v
    });
  } else {
    delete l.data[k];
    uewWW.fire(w, "DELETE", "/Matchmaking/LobbyData", {
      lobbyId: s,
      key: k
    });
  }
}

function _ww_lobby_setting(what, id, val, sval) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(132, 0, 1, what, id, val, sval);
  id >>>= 0;
  sval >>>= 0;
  const w = uewWW.get(), s = UTF8ToString(id), l = uewWW.lobby(w, s);
  if (what === 0) uewWW.fire(w, "POST", "/Matchmaking/LobbyVisibility", {
    lobbyId: s,
    mode: [ "private", "friends", "public", "invisible" ][val] || "public"
  }); else if (what === 1) {
    l.joinable = !!val;
    uewWW.fire(w, "POST", "/Matchmaking/LobbyJoinable", {
      lobbyId: s,
      joinable: !!val
    });
  } else if (what === 2) {
    l.maxMembers = val;
    uewWW.fire(w, "POST", "/Matchmaking/LobbyMaxMembers", {
      lobbyId: s,
      maxMembers: val
    });
  } else if (what === 3) {
    const o = UTF8ToString(sval);
    l.ownerId = o;
    uewWW.fire(w, "POST", "/Matchmaking/LobbyOwner", {
      lobbyId: s,
      ownerId: o
    });
  }
}

function _ww_lobby_str(what, id, i, buf, cap) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(133, 0, 1, what, id, i, buf, cap);
  id >>>= 0;
  buf >>>= 0;
  const l = uewWW.get().lobbies.get(UTF8ToString(id));
  let s = what < 2 ? "0" : "";
  if (l) {
    if (what === 0) s = l.ownerId; else if (what === 1) s = l.members[i] || "0"; else {
      const k = Object.keys(l.data)[i];
      if (k !== undefined) s = what === 2 ? k : String(l.data[k]);
    }
  }
  return uewWW.put(s, buf, cap);
}

function _ww_name(id, buf, cap) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(134, 0, 1, id, buf, cap);
  id >>>= 0;
  buf >>>= 0;
  const w = uewWW.get(), s = UTF8ToString(id);
  return uewWW.put(s === w.me || s === "0" ? w.name : (w.names.get(s) || ""), buf, cap);
}

function _ww_p2p_peek(channel) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(135, 0, 1, channel);
  const q = uewWW.get().packets.get(channel);
  return q && q.length ? q[0][1].length : -1;
}

function _ww_p2p_read(channel, buf, cap, who, whocap) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(136, 0, 1, channel, buf, cap, who, whocap);
  buf >>>= 0;
  who >>>= 0;
  const q = uewWW.get().packets.get(channel);
  if (!q || !q.length) return -1;
  const [from, bytes] = q.shift();
  const n = Math.min(cap, bytes.length);
  (growMemViews(), HEAPU8).set(bytes.subarray(0, n), buf >>> 0);
  uewWW.put(from, who, whocap);
  return n;
}

function _ww_p2p_send(to, data, len, channel) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(137, 0, 1, to, data, len, channel);
  to >>>= 0;
  data >>>= 0;
  const w = uewWW.get();
  if (w.state !== 1) return 0;
  const b = (growMemViews(), HEAPU8).subarray(data >>> 0, data + len >>> 0);
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
  uewWW.send(w, {
    type: "P2PPacket",
    to: UTF8ToString(to),
    channel,
    data: btoa(s)
  });
  return 1;
}

function _ww_p2p_session(what, peer) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(138, 0, 1, what, peer);
  peer >>>= 0;
  const w = uewWW.get(), s = UTF8ToString(peer);
  if (what === 0) w.peers.add(s); else w.peers.delete(s);
  uewWW.fire(w, "POST", what === 0 ? "/Networking/AcceptSession" : "/Networking/CloseSession", {
    peerSteamId: s
  });
}

function _ww_presence(key, value) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(139, 0, 1, key, value);
  key >>>= 0;
  value >>>= 0;
  const w = uewWW.get();
  if (!key) {
    uewWW.fire(w, "DELETE", "/Friends/RichPresence");
    return;
  }
  uewWW.fire(w, "POST", "/Friends/RichPresence", {
    key: UTF8ToString(key),
    value: value ? UTF8ToString(value) : ""
  });
}

function _ww_req_count(id) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(140, 0, 1, id);
  const r = uewWW.get().reqs.get(id);
  return r && Array.isArray(r.result) ? r.result.length : 0;
}

function _ww_req_free(id) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(141, 0, 1, id);
  uewWW.get().reqs.delete(id);
}

function _ww_req_lobby(id, i, buf, cap) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(142, 0, 1, id, i, buf, cap);
  buf >>>= 0;
  const r = uewWW.get().reqs.get(id);
  const v = r && r.result;
  const s = !v ? "0" : Array.isArray(v) ? (v[i] || "0") : String(v);
  return uewWW.put(s, buf, cap);
}

function _ww_req_status(id) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(143, 0, 1, id);
  const r = uewWW.get().reqs.get(id);
  return r ? r.status : 2;
}

function _ww_self(buf, cap) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(144, 0, 1, buf, cap);
  buf >>>= 0;
  return uewWW.put(uewWW.get().me, buf, cap);
}

function _ww_state() {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(145, 0, 1);
  return uewWW.get().state;
}

var stringToUTF8OnStack = str => {
  var size = lengthBytesUTF8(str) + 1;
  var ret = stackAlloc(size);
  stringToUTF8(str, ret, size);
  return ret;
};

var FS_createPath = (...args) => FS.createPath(...args);

var FS_unlink = (...args) => FS.unlink(...args);

var FS_createLazyFile = (...args) => FS.createLazyFile(...args);

var FS_createDevice = (...args) => FS.createDevice(...args);

var _exit = exitJS;

var syscallGetVarargP = syscallGetVarargI;

var findCanvasEventTarget = findEventTarget;

var _emscripten_webgl_create_context = __emscripten_webgl_do_create_context;

var _glActiveTexture = _emscripten_glActiveTexture;

var _glAttachShader = _emscripten_glAttachShader;

var _glBindBuffer = _emscripten_glBindBuffer;

var _glBindBufferRange = _emscripten_glBindBufferRange;

var _glBindFramebuffer = _emscripten_glBindFramebuffer;

var _glBindSampler = _emscripten_glBindSampler;

var _glBindTexture = _emscripten_glBindTexture;

var _glBindVertexArray = _emscripten_glBindVertexArray;

var _glBlendColor = _emscripten_glBlendColor;

var _glBlendEquationSeparate = _emscripten_glBlendEquationSeparate;

var _glBlendFuncSeparate = _emscripten_glBlendFuncSeparate;

var _glBlitFramebuffer = _emscripten_glBlitFramebuffer;

var _glBufferData = _emscripten_glBufferData;

var _glBufferSubData = _emscripten_glBufferSubData;

var _glClearBufferfi = _emscripten_glClearBufferfi;

var _glClearBufferfv = _emscripten_glClearBufferfv;

var _glClearBufferiv = _emscripten_glClearBufferiv;

var _glClearBufferuiv = _emscripten_glClearBufferuiv;

var _glColorMask = _emscripten_glColorMask;

var _glCompileShader = _emscripten_glCompileShader;

var _glCompressedTexSubImage2D = _emscripten_glCompressedTexSubImage2D;

var _glCompressedTexSubImage3D = _emscripten_glCompressedTexSubImage3D;

var _glCopyBufferSubData = _emscripten_glCopyBufferSubData;

var _glCopyTexSubImage2D = _emscripten_glCopyTexSubImage2D;

var _glCopyTexSubImage3D = _emscripten_glCopyTexSubImage3D;

var _glCreateProgram = _emscripten_glCreateProgram;

var _glCreateShader = _emscripten_glCreateShader;

var _glCullFace = _emscripten_glCullFace;

var _glDeleteFramebuffers = _emscripten_glDeleteFramebuffers;

var _glDeleteProgram = _emscripten_glDeleteProgram;

var _glDeleteShader = _emscripten_glDeleteShader;

var _glDepthFunc = _emscripten_glDepthFunc;

var _glDepthMask = _emscripten_glDepthMask;

var _glDepthRangef = _emscripten_glDepthRangef;

var _glDisable = _emscripten_glDisable;

var _glDisableVertexAttribArray = _emscripten_glDisableVertexAttribArray;

var _glDrawArrays = _emscripten_glDrawArrays;

var _glDrawArraysInstanced = _emscripten_glDrawArraysInstanced;

var _glDrawBuffers = _emscripten_glDrawBuffers;

var _glDrawElements = _emscripten_glDrawElements;

var _glDrawElementsInstanced = _emscripten_glDrawElementsInstanced;

var _glEnable = _emscripten_glEnable;

var _glEnableVertexAttribArray = _emscripten_glEnableVertexAttribArray;

var _glFramebufferTexture2D = _emscripten_glFramebufferTexture2D;

var _glFramebufferTextureLayer = _emscripten_glFramebufferTextureLayer;

var _glFrontFace = _emscripten_glFrontFace;

var _glGenBuffers = _emscripten_glGenBuffers;

var _glGenFramebuffers = _emscripten_glGenFramebuffers;

var _glGenSamplers = _emscripten_glGenSamplers;

var _glGenTextures = _emscripten_glGenTextures;

var _glGenVertexArrays = _emscripten_glGenVertexArrays;

var _glGetProgramInfoLog = _emscripten_glGetProgramInfoLog;

var _glGetProgramiv = _emscripten_glGetProgramiv;

var _glGetShaderInfoLog = _emscripten_glGetShaderInfoLog;

var _glGetShaderiv = _emscripten_glGetShaderiv;

var _glGetUniformBlockIndex = _emscripten_glGetUniformBlockIndex;

var _glGetUniformLocation = _emscripten_glGetUniformLocation;

var _glLinkProgram = _emscripten_glLinkProgram;

var _glPixelStorei = _emscripten_glPixelStorei;

var _glPolygonOffset = _emscripten_glPolygonOffset;

var _glSamplerParameterf = _emscripten_glSamplerParameterf;

var _glSamplerParameteri = _emscripten_glSamplerParameteri;

var _glScissor = _emscripten_glScissor;

var _glShaderSource = _emscripten_glShaderSource;

var _glStencilFuncSeparate = _emscripten_glStencilFuncSeparate;

var _glStencilMask = _emscripten_glStencilMask;

var _glStencilOpSeparate = _emscripten_glStencilOpSeparate;

var _glTexParameteri = _emscripten_glTexParameteri;

var _glTexStorage2D = _emscripten_glTexStorage2D;

var _glTexStorage3D = _emscripten_glTexStorage3D;

var _glTexSubImage2D = _emscripten_glTexSubImage2D;

var _glTexSubImage3D = _emscripten_glTexSubImage3D;

var _glUniform1i = _emscripten_glUniform1i;

var _glUniform1iv = _emscripten_glUniform1iv;

var _glUniformBlockBinding = _emscripten_glUniformBlockBinding;

var _glUseProgram = _emscripten_glUseProgram;

var _glVertexAttrib4f = _emscripten_glVertexAttrib4f;

var _glVertexAttribDivisor = _emscripten_glVertexAttribDivisor;

var _glVertexAttribIPointer = _emscripten_glVertexAttribIPointer;

var _glVertexAttribPointer = _emscripten_glVertexAttribPointer;

var _glViewport = _emscripten_glViewport;

PThread.init();

FS.createPreloadedFile = FS_createPreloadedFile;

FS.preloadFile = FS_preloadFile;

FS.staticInit();

for (let i = 0; i < 32; ++i) tempFixedLengthArray.push(new Array(i));

var miniTempWebGLIntBuffersStorage = new Int32Array(GL_POOL_TEMP_BUFFERS_SIZE);

// Create GL_POOL_TEMP_BUFFERS_SIZE+1 temporary buffers, for uploads of size 0 through GL_POOL_TEMP_BUFFERS_SIZE inclusive
for (let i = 0; i <= GL_POOL_TEMP_BUFFERS_SIZE; ++i) {
  miniTempWebGLIntBuffers[i] = miniTempWebGLIntBuffersStorage.subarray(0, i);
}

if (typeof process == "object" && process.on) process.on("unhandledRejection", e => {
  if (e == "unwind" || (e && e.name == "ExitStatus")) return;
  throw e;
});

if (typeof addEventListener == "function") addEventListener("unhandledrejection", e => {
  if (e.reason == "unwind" || (e.reason && e.reason.name == "ExitStatus")) e.preventDefault();
});

if (typeof ENVIRONMENT_IS_PTHREAD != "undefined" && ENVIRONMENT_IS_PTHREAD && typeof self != "undefined" && typeof self.addEventListener == "function") self.addEventListener("error", e => {
  if (e.error && e.error.stack) err("[worker crash] " + e.error.stack);
});

// End JS library code
// include: postlibrary.js
// This file is included after the automatically-generated JS library code
// but before the wasm module is created.
{
  // With WASM_ESM_INTEGRATION this has to happen at the top level and not
  // delayed until processModuleArgs.
  initMemory();
  // Begin ATMODULES hooks
  if (Module["noExitRuntime"]) noExitRuntime = Module["noExitRuntime"];
  if (Module["print"]) out = Module["print"];
  if (Module["printErr"]) err = Module["printErr"];
  // End ATMODULES hooks
  if (Module["arguments"]) programArgs = Module["arguments"];
  if (Module["thisProgram"]) thisProgram = Module["thisProgram"];
  var preInit = Module["preInit"];
  if (preInit) {
    if (typeof preInit === "function") Module["preInit"] = preInit = [ preInit ];
    // Written as a loop so that preInit functions that themselves add more
    // preInit functions.  Is this actually needed?
    while (preInit.length > 0) {
      preInit.shift()();
    }
  }
}

// Begin runtime exports
Module["addRunDependency"] = addRunDependency;

Module["removeRunDependency"] = removeRunDependency;

Module["FS_preloadFile"] = FS_preloadFile;

Module["FS_unlink"] = FS_unlink;

Module["FS_createPath"] = FS_createPath;

Module["FS_createDevice"] = FS_createDevice;

Module["FS_createDataFile"] = FS_createDataFile;

Module["FS_createLazyFile"] = FS_createLazyFile;

// End runtime exports
// Begin JS library exports
// End JS library exports
// end include: postlibrary.js
// proxiedFunctionTable specifies the list of functions that can be called
// either synchronously or asynchronously from other threads in postMessage()d
// or internally queued events. This way a pthread in a Worker can synchronously
// access e.g. the DOM on the main thread.
var proxiedFunctionTable = [ exitOnMainThread, _proc_exit, pthreadCreateProxied, ___syscall_fcntl64, ___syscall_fstat64, ___syscall_ftruncate64, ___syscall_getdents64, ___syscall_ioctl, ___syscall_lstat64, ___syscall_mkdirat, ___syscall_newfstatat, ___syscall_openat, ___syscall_renameat, ___syscall_rmdir, ___syscall_stat64, ___syscall_unlinkat, _emscripten_force_exit, getCanvasSizeMainThread, _environ_get, _environ_sizes_get, _fd_close, _fd_read, _fd_seek, _fd_write, _host_gamepad, _host_lock_pointer, _host_open_url, _host_page_int, _host_query_flag, _host_query_hex, _host_query_int, _host_rumble, _host_show_cursor, _inet_claims, _inet_request, _inet_take, _js_audio_open, _js_audio_queued, _js_audio_restart, _js_audio_write, _net_avail, _net_claim, _net_claim_ip, _net_close, _net_open, _net_recv, _net_recv1, _net_send, _scm_cancel, _scm_eticket_async, _scm_req_free, _scm_req_status, _scm_req_take, _scm_start, _scm_state, _scm_ticket, _scm_ticket_acked, _scm_ticket_async, _uew_js_frame_request, _uew_rf_find, _uew_rf_list, _uew_rf_read_cached, _uew_rf_ready, _uew_rf_start, _uew_vpx_available, _uew_vpx_close, _uew_vpx_decode, _uew_vpx_info, _uew_vpx_open, _uew_vpx_poll, _uew_vpx_take, _uewg_begin_pass, _uewg_bindgroup_bin, _uewg_bindgroup_create, _uewg_buffer_copy, _uewg_buffer_copy_ring, _uewg_buffer_create, _uewg_buffer_write, _uewg_clear, _uewg_clear_buffer, _uewg_compute_pipeline_create, _uewg_copy_buffer, _uewg_copy_texture, _uewg_dispatch, _uewg_draw, _uewg_expand_typed, _uewg_flush, _uewg_gen_mips, _uewg_gs, _uewg_has_feature, _uewg_layout_create, _uewg_max_dynamic_ubo, _uewg_max_storage, _uewg_pipe_ready, _uewg_present, _uewg_readback_done, _uewg_readback_finish, _uewg_readback_latest, _uewg_readback_start, _uewg_release, _uewg_render_pipeline_create, _uewg_retire, _uewg_ring_reset, _uewg_ring_used_at, _uewg_sampler_create, _uewg_shader_create, _uewg_submit, _uewg_texture_copy_ring, _uewg_texture_create, _uewg_texture_write, _uewg_timestamp, _uewg_timestamp_get, _uewg_view_create, _web_canvas_h, _web_canvas_w, _web_input_init, _web_next_event, _web_trace_filter, _ww_chat_get, _ww_chat_send, _ww_create_lobby, _ww_device, _ww_event, _ww_iface_version, _ww_init, _ww_join_lobby, _ww_lobby_get, _ww_lobby_int, _ww_lobby_leave, _ww_lobby_list, _ww_lobby_refresh, _ww_lobby_set, _ww_lobby_setting, _ww_lobby_str, _ww_name, _ww_p2p_peek, _ww_p2p_read, _ww_p2p_send, _ww_p2p_session, _ww_presence, _ww_req_count, _ww_req_free, _ww_req_lobby, _ww_req_status, _ww_self, _ww_state ];

function __asyncjs__uew_js_switch(from, to, target) {
  return Asyncify.handleAsync(async () => {
    Module.uewRes = Module.uewRes || {};
    await new Promise(resolve => {
      Module.uewRes[from] = resolve;
      const r = Module.uewRes[to];
      if (r) {
        delete Module.uewRes[to];
        r();
      } else Module._uew_ctx_start(target);
    });
  });
}

__asyncjs__uew_js_switch.sig = "viii";

function uew_js_ctx_drop(id) {
  if (Module.uewRes) delete Module.uewRes[id];
}

uew_js_ctx_drop.sig = "vi";

function __asyncjs__uew_js_sleep(ms) {
  return Asyncify.handleAsync(async () => {
    await new Promise(r => setTimeout(r, ms));
  });
}

function __asyncjs__uew_js_yield() {
  return Asyncify.handleAsync(async () => {
    await new Promise(r => {
      if (typeof setImmediate === "function") {
        setImmediate(r);
        return;
      }
      const ch = Module.uewYieldCh || (Module.uewYieldCh = new MessageChannel);
      ch.port1.onmessage = () => r();
      ch.port2.postMessage(0);
    });
  });
}

__asyncjs__uew_js_yield.sig = "v";

function __asyncjs__uew_js_idle(ms, wake) {
  return Asyncify.handleAsync(async () => {
    await new Promise(r => {
      let done = false;
      const fin = () => {
        if (!done) {
          done = true;
          Module.uewIdleWake = null;
          r();
        }
      };
      const wp = typeof wake == "bigint" ? Number(wake) : wake >>> 0;
      if (wp && typeof SharedArrayBuffer != "undefined" && (growMemViews(), HEAP32).buffer instanceof SharedArrayBuffer) {
        const w = Atomics.waitAsync((growMemViews(), HEAP32), wp / 4, Atomics.load((growMemViews(), 
        HEAP32), wp / 4), ms);
        if (w.async) w.value.then(fin);
      }
      Module.uewIdleWake = fin;
      if (ms < 3) {
        if (typeof setImmediate === "function") {
          setImmediate(fin);
          return;
        }
        const ch = Module.uewIdleCh || (Module.uewIdleCh = new MessageChannel);
        ch.port1.onmessage = () => fin();
        ch.port2.postMessage(0);
      } else setTimeout(fin, ms - 1);
    });
  });
}

__asyncjs__uew_js_idle.sig = "vdi";

function __asyncjs__uew_rf_read(id, off, len, dst) {
  return Asyncify.handleAsync(async () => await Module.uewFiles.read(id, off, len, typeof dst == "bigint" ? Number(dst) : dst >>> 0));
}

__asyncjs__uew_rf_read.sig = "iidii";

function __asyncjs__host_frame_yield() {
  return Asyncify.handleAsync(async () => {
    await new Promise(r => (typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame : setTimeout)(r));
  });
}

// Imports from the Wasm binary.
var _malloc, _free, _uew_d3d9_trace, _fflush, _uew_ue_console, _uew_set_speed, _uew_ctx_start, __emscripten_stack_restore, _emscripten_stack_get_current, _main, _uew_set_trace, _uew_threads, __emscripten_tls_init, _pthread_self, ___funcs_on_exit, __emscripten_thread_init, ___set_thread_state, __emscripten_thread_crashed, __emscripten_run_js_on_main_thread_done, __emscripten_run_js_on_main_thread, __emscripten_thread_free_data, __emscripten_thread_exit, __emscripten_check_mailbox, _emscripten_stack_set_limits, __emscripten_stack_alloc, __indirect_function_table, wasmTable;

function assignWasmExports(wasmExports) {
  _malloc = wasmExports["malloc"];
  _free = wasmExports["free"];
  _uew_d3d9_trace = Module["_uew_d3d9_trace"] = wasmExports["uew_d3d9_trace"];
  _fflush = wasmExports["fflush"];
  _uew_ue_console = Module["_uew_ue_console"] = wasmExports["uew_ue_console"];
  _uew_set_speed = Module["_uew_set_speed"] = wasmExports["uew_set_speed"];
  _uew_ctx_start = Module["_uew_ctx_start"] = wasmExports["uew_ctx_start"];
  __emscripten_stack_restore = wasmExports["_emscripten_stack_restore"];
  _emscripten_stack_get_current = wasmExports["emscripten_stack_get_current"];
  _main = Module["_main"] = wasmExports["__main_argc_argv"];
  _uew_set_trace = Module["_uew_set_trace"] = wasmExports["uew_set_trace"];
  _uew_threads = Module["_uew_threads"] = wasmExports["uew_threads"];
  __emscripten_tls_init = wasmExports["_emscripten_tls_init"];
  _pthread_self = wasmExports["pthread_self"];
  ___funcs_on_exit = wasmExports["__funcs_on_exit"];
  __emscripten_thread_init = wasmExports["_emscripten_thread_init"];
  ___set_thread_state = wasmExports["__set_thread_state"];
  __emscripten_thread_crashed = wasmExports["_emscripten_thread_crashed"];
  __emscripten_run_js_on_main_thread_done = wasmExports["_emscripten_run_js_on_main_thread_done"];
  __emscripten_run_js_on_main_thread = wasmExports["_emscripten_run_js_on_main_thread"];
  __emscripten_thread_free_data = wasmExports["_emscripten_thread_free_data"];
  __emscripten_thread_exit = wasmExports["_emscripten_thread_exit"];
  __emscripten_check_mailbox = wasmExports["_emscripten_check_mailbox"];
  _emscripten_stack_set_limits = wasmExports["emscripten_stack_set_limits"];
  __emscripten_stack_alloc = wasmExports["_emscripten_stack_alloc"];
  __indirect_function_table = wasmTable = wasmExports["__indirect_function_table"];
}

var wasmImports;

function assignWasmImports() {
  wasmImports = {
    /** @export */ __asyncjs__uew_js_idle,
    /** @export */ __asyncjs__uew_js_switch,
    /** @export */ __asyncjs__uew_js_yield,
    /** @export */ __asyncjs__uew_rf_read,
    /** @export */ __pthread_create_js: ___pthread_create_js,
    /** @export */ __syscall_fcntl64: ___syscall_fcntl64,
    /** @export */ __syscall_fstat64: ___syscall_fstat64,
    /** @export */ __syscall_ftruncate64: ___syscall_ftruncate64,
    /** @export */ __syscall_getdents64: ___syscall_getdents64,
    /** @export */ __syscall_ioctl: ___syscall_ioctl,
    /** @export */ __syscall_lstat64: ___syscall_lstat64,
    /** @export */ __syscall_mkdirat: ___syscall_mkdirat,
    /** @export */ __syscall_newfstatat: ___syscall_newfstatat,
    /** @export */ __syscall_openat: ___syscall_openat,
    /** @export */ __syscall_renameat: ___syscall_renameat,
    /** @export */ __syscall_rmdir: ___syscall_rmdir,
    /** @export */ __syscall_stat64: ___syscall_stat64,
    /** @export */ __syscall_unlinkat: ___syscall_unlinkat,
    /** @export */ _emscripten_init_main_thread_js: __emscripten_init_main_thread_js,
    /** @export */ _emscripten_notify_mailbox_postmessage: __emscripten_notify_mailbox_postmessage,
    /** @export */ _emscripten_receive_on_main_thread_js: __emscripten_receive_on_main_thread_js,
    /** @export */ _emscripten_thread_cleanup: __emscripten_thread_cleanup,
    /** @export */ _emscripten_thread_mailbox_await: __emscripten_thread_mailbox_await,
    /** @export */ _emscripten_thread_set_strongref: __emscripten_thread_set_strongref,
    /** @export */ _gmtime_js: __gmtime_js,
    /** @export */ _timegm_js: __timegm_js,
    /** @export */ _tzset_js: __tzset_js,
    /** @export */ clock_time_get: _clock_time_get,
    /** @export */ emscripten_check_blocking_allowed: _emscripten_check_blocking_allowed,
    /** @export */ emscripten_date_now: _emscripten_date_now,
    /** @export */ emscripten_exit_with_live_runtime: _emscripten_exit_with_live_runtime,
    /** @export */ emscripten_force_exit: _emscripten_force_exit,
    /** @export */ emscripten_get_callstack: _emscripten_get_callstack,
    /** @export */ emscripten_get_canvas_element_size: _emscripten_get_canvas_element_size,
    /** @export */ emscripten_get_now: _emscripten_get_now,
    /** @export */ emscripten_num_logical_cores: _emscripten_num_logical_cores,
    /** @export */ emscripten_resize_heap: _emscripten_resize_heap,
    /** @export */ emscripten_webgl_create_context: _emscripten_webgl_create_context,
    /** @export */ emscripten_webgl_enable_extension: _emscripten_webgl_enable_extension,
    /** @export */ emscripten_webgl_make_context_current: _emscripten_webgl_make_context_current,
    /** @export */ environ_get: _environ_get,
    /** @export */ environ_sizes_get: _environ_sizes_get,
    /** @export */ exit: _exit,
    /** @export */ fd_close: _fd_close,
    /** @export */ fd_read: _fd_read,
    /** @export */ fd_seek: _fd_seek,
    /** @export */ fd_write: _fd_write,
    /** @export */ glActiveTexture: _glActiveTexture,
    /** @export */ glAttachShader: _glAttachShader,
    /** @export */ glBindBuffer: _glBindBuffer,
    /** @export */ glBindBufferRange: _glBindBufferRange,
    /** @export */ glBindFramebuffer: _glBindFramebuffer,
    /** @export */ glBindSampler: _glBindSampler,
    /** @export */ glBindTexture: _glBindTexture,
    /** @export */ glBindVertexArray: _glBindVertexArray,
    /** @export */ glBlendColor: _glBlendColor,
    /** @export */ glBlendEquationSeparate: _glBlendEquationSeparate,
    /** @export */ glBlendFuncSeparate: _glBlendFuncSeparate,
    /** @export */ glBlitFramebuffer: _glBlitFramebuffer,
    /** @export */ glBufferData: _glBufferData,
    /** @export */ glBufferSubData: _glBufferSubData,
    /** @export */ glClearBufferfi: _glClearBufferfi,
    /** @export */ glClearBufferfv: _glClearBufferfv,
    /** @export */ glClearBufferiv: _glClearBufferiv,
    /** @export */ glClearBufferuiv: _glClearBufferuiv,
    /** @export */ glColorMask: _glColorMask,
    /** @export */ glCompileShader: _glCompileShader,
    /** @export */ glCompressedTexSubImage2D: _glCompressedTexSubImage2D,
    /** @export */ glCompressedTexSubImage3D: _glCompressedTexSubImage3D,
    /** @export */ glCopyBufferSubData: _glCopyBufferSubData,
    /** @export */ glCopyTexSubImage2D: _glCopyTexSubImage2D,
    /** @export */ glCopyTexSubImage3D: _glCopyTexSubImage3D,
    /** @export */ glCreateProgram: _glCreateProgram,
    /** @export */ glCreateShader: _glCreateShader,
    /** @export */ glCullFace: _glCullFace,
    /** @export */ glDeleteFramebuffers: _glDeleteFramebuffers,
    /** @export */ glDeleteProgram: _glDeleteProgram,
    /** @export */ glDeleteShader: _glDeleteShader,
    /** @export */ glDepthFunc: _glDepthFunc,
    /** @export */ glDepthMask: _glDepthMask,
    /** @export */ glDepthRangef: _glDepthRangef,
    /** @export */ glDisable: _glDisable,
    /** @export */ glDisableVertexAttribArray: _glDisableVertexAttribArray,
    /** @export */ glDrawArrays: _glDrawArrays,
    /** @export */ glDrawArraysInstanced: _glDrawArraysInstanced,
    /** @export */ glDrawBuffers: _glDrawBuffers,
    /** @export */ glDrawElements: _glDrawElements,
    /** @export */ glDrawElementsInstanced: _glDrawElementsInstanced,
    /** @export */ glEnable: _glEnable,
    /** @export */ glEnableVertexAttribArray: _glEnableVertexAttribArray,
    /** @export */ glFramebufferTexture2D: _glFramebufferTexture2D,
    /** @export */ glFramebufferTextureLayer: _glFramebufferTextureLayer,
    /** @export */ glFrontFace: _glFrontFace,
    /** @export */ glGenBuffers: _glGenBuffers,
    /** @export */ glGenFramebuffers: _glGenFramebuffers,
    /** @export */ glGenSamplers: _glGenSamplers,
    /** @export */ glGenTextures: _glGenTextures,
    /** @export */ glGenVertexArrays: _glGenVertexArrays,
    /** @export */ glGetProgramInfoLog: _glGetProgramInfoLog,
    /** @export */ glGetProgramiv: _glGetProgramiv,
    /** @export */ glGetShaderInfoLog: _glGetShaderInfoLog,
    /** @export */ glGetShaderiv: _glGetShaderiv,
    /** @export */ glGetUniformBlockIndex: _glGetUniformBlockIndex,
    /** @export */ glGetUniformLocation: _glGetUniformLocation,
    /** @export */ glLinkProgram: _glLinkProgram,
    /** @export */ glPixelStorei: _glPixelStorei,
    /** @export */ glPolygonOffset: _glPolygonOffset,
    /** @export */ glSamplerParameterf: _glSamplerParameterf,
    /** @export */ glSamplerParameteri: _glSamplerParameteri,
    /** @export */ glScissor: _glScissor,
    /** @export */ glShaderSource: _glShaderSource,
    /** @export */ glStencilFuncSeparate: _glStencilFuncSeparate,
    /** @export */ glStencilMask: _glStencilMask,
    /** @export */ glStencilOpSeparate: _glStencilOpSeparate,
    /** @export */ glTexParameteri: _glTexParameteri,
    /** @export */ glTexStorage2D: _glTexStorage2D,
    /** @export */ glTexStorage3D: _glTexStorage3D,
    /** @export */ glTexSubImage2D: _glTexSubImage2D,
    /** @export */ glTexSubImage3D: _glTexSubImage3D,
    /** @export */ glUniform1i: _glUniform1i,
    /** @export */ glUniform1iv: _glUniform1iv,
    /** @export */ glUniformBlockBinding: _glUniformBlockBinding,
    /** @export */ glUseProgram: _glUseProgram,
    /** @export */ glVertexAttrib4f: _glVertexAttrib4f,
    /** @export */ glVertexAttribDivisor: _glVertexAttribDivisor,
    /** @export */ glVertexAttribIPointer: _glVertexAttribIPointer,
    /** @export */ glVertexAttribPointer: _glVertexAttribPointer,
    /** @export */ glViewport: _glViewport,
    /** @export */ host_gamepad: _host_gamepad,
    /** @export */ host_lock_pointer: _host_lock_pointer,
    /** @export */ host_open_url: _host_open_url,
    /** @export */ host_page_int: _host_page_int,
    /** @export */ host_query_flag: _host_query_flag,
    /** @export */ host_query_hex: _host_query_hex,
    /** @export */ host_query_int: _host_query_int,
    /** @export */ host_rumble: _host_rumble,
    /** @export */ host_show_cursor: _host_show_cursor,
    /** @export */ inet_claims: _inet_claims,
    /** @export */ inet_request: _inet_request,
    /** @export */ inet_take: _inet_take,
    /** @export */ js_audio_open: _js_audio_open,
    /** @export */ js_audio_queued: _js_audio_queued,
    /** @export */ js_audio_restart: _js_audio_restart,
    /** @export */ js_audio_write: _js_audio_write,
    /** @export */ memory: wasmMemory,
    /** @export */ net_avail: _net_avail,
    /** @export */ net_claim: _net_claim,
    /** @export */ net_claim_ip: _net_claim_ip,
    /** @export */ net_close: _net_close,
    /** @export */ net_open: _net_open,
    /** @export */ net_recv: _net_recv,
    /** @export */ net_recv1: _net_recv1,
    /** @export */ net_send: _net_send,
    /** @export */ random_get: _random_get,
    /** @export */ scm_cancel: _scm_cancel,
    /** @export */ scm_eticket_async: _scm_eticket_async,
    /** @export */ scm_req_free: _scm_req_free,
    /** @export */ scm_req_status: _scm_req_status,
    /** @export */ scm_req_take: _scm_req_take,
    /** @export */ scm_start: _scm_start,
    /** @export */ scm_state: _scm_state,
    /** @export */ scm_ticket: _scm_ticket,
    /** @export */ scm_ticket_acked: _scm_ticket_acked,
    /** @export */ scm_ticket_async: _scm_ticket_async,
    /** @export */ uew_js_ctx_drop,
    /** @export */ uew_js_frame_request: _uew_js_frame_request,
    /** @export */ uew_rf_find: _uew_rf_find,
    /** @export */ uew_rf_list: _uew_rf_list,
    /** @export */ uew_rf_read_cached: _uew_rf_read_cached,
    /** @export */ uew_rf_ready: _uew_rf_ready,
    /** @export */ uew_rf_start: _uew_rf_start,
    /** @export */ uew_vpx_available: _uew_vpx_available,
    /** @export */ uew_vpx_close: _uew_vpx_close,
    /** @export */ uew_vpx_decode: _uew_vpx_decode,
    /** @export */ uew_vpx_info: _uew_vpx_info,
    /** @export */ uew_vpx_open: _uew_vpx_open,
    /** @export */ uew_vpx_poll: _uew_vpx_poll,
    /** @export */ uew_vpx_take: _uew_vpx_take,
    /** @export */ uewg_begin_pass: _uewg_begin_pass,
    /** @export */ uewg_bindgroup_bin: _uewg_bindgroup_bin,
    /** @export */ uewg_bindgroup_create: _uewg_bindgroup_create,
    /** @export */ uewg_buffer_copy: _uewg_buffer_copy,
    /** @export */ uewg_buffer_copy_ring: _uewg_buffer_copy_ring,
    /** @export */ uewg_buffer_create: _uewg_buffer_create,
    /** @export */ uewg_buffer_write: _uewg_buffer_write,
    /** @export */ uewg_clear: _uewg_clear,
    /** @export */ uewg_clear_buffer: _uewg_clear_buffer,
    /** @export */ uewg_compute_pipeline_create: _uewg_compute_pipeline_create,
    /** @export */ uewg_copy_buffer: _uewg_copy_buffer,
    /** @export */ uewg_copy_texture: _uewg_copy_texture,
    /** @export */ uewg_dispatch: _uewg_dispatch,
    /** @export */ uewg_draw: _uewg_draw,
    /** @export */ uewg_expand_typed: _uewg_expand_typed,
    /** @export */ uewg_flush: _uewg_flush,
    /** @export */ uewg_gen_mips: _uewg_gen_mips,
    /** @export */ uewg_gs: _uewg_gs,
    /** @export */ uewg_has_feature: _uewg_has_feature,
    /** @export */ uewg_init: _uewg_init,
    /** @export */ uewg_layout_create: _uewg_layout_create,
    /** @export */ uewg_max_dynamic_ubo: _uewg_max_dynamic_ubo,
    /** @export */ uewg_max_storage: _uewg_max_storage,
    /** @export */ uewg_pipe_ready: _uewg_pipe_ready,
    /** @export */ uewg_present: _uewg_present,
    /** @export */ uewg_readback_done: _uewg_readback_done,
    /** @export */ uewg_readback_finish: _uewg_readback_finish,
    /** @export */ uewg_readback_latest: _uewg_readback_latest,
    /** @export */ uewg_readback_start: _uewg_readback_start,
    /** @export */ uewg_release: _uewg_release,
    /** @export */ uewg_render_pipeline_create: _uewg_render_pipeline_create,
    /** @export */ uewg_retire: _uewg_retire,
    /** @export */ uewg_ring_reset: _uewg_ring_reset,
    /** @export */ uewg_ring_used_at: _uewg_ring_used_at,
    /** @export */ uewg_sampler_create: _uewg_sampler_create,
    /** @export */ uewg_shader_create: _uewg_shader_create,
    /** @export */ uewg_submit: _uewg_submit,
    /** @export */ uewg_texture_copy_ring: _uewg_texture_copy_ring,
    /** @export */ uewg_texture_create: _uewg_texture_create,
    /** @export */ uewg_texture_write: _uewg_texture_write,
    /** @export */ uewg_timestamp: _uewg_timestamp,
    /** @export */ uewg_timestamp_get: _uewg_timestamp_get,
    /** @export */ uewg_view_create: _uewg_view_create,
    /** @export */ web_canvas_h: _web_canvas_h,
    /** @export */ web_canvas_w: _web_canvas_w,
    /** @export */ web_input_init: _web_input_init,
    /** @export */ web_next_event: _web_next_event,
    /** @export */ web_trace_filter: _web_trace_filter,
    /** @export */ ww_chat_get: _ww_chat_get,
    /** @export */ ww_chat_send: _ww_chat_send,
    /** @export */ ww_create_lobby: _ww_create_lobby,
    /** @export */ ww_device: _ww_device,
    /** @export */ ww_event: _ww_event,
    /** @export */ ww_iface_version: _ww_iface_version,
    /** @export */ ww_init: _ww_init,
    /** @export */ ww_join_lobby: _ww_join_lobby,
    /** @export */ ww_lobby_get: _ww_lobby_get,
    /** @export */ ww_lobby_int: _ww_lobby_int,
    /** @export */ ww_lobby_leave: _ww_lobby_leave,
    /** @export */ ww_lobby_list: _ww_lobby_list,
    /** @export */ ww_lobby_refresh: _ww_lobby_refresh,
    /** @export */ ww_lobby_set: _ww_lobby_set,
    /** @export */ ww_lobby_setting: _ww_lobby_setting,
    /** @export */ ww_lobby_str: _ww_lobby_str,
    /** @export */ ww_name: _ww_name,
    /** @export */ ww_p2p_peek: _ww_p2p_peek,
    /** @export */ ww_p2p_read: _ww_p2p_read,
    /** @export */ ww_p2p_send: _ww_p2p_send,
    /** @export */ ww_p2p_session: _ww_p2p_session,
    /** @export */ ww_presence: _ww_presence,
    /** @export */ ww_req_count: _ww_req_count,
    /** @export */ ww_req_free: _ww_req_free,
    /** @export */ ww_req_lobby: _ww_req_lobby,
    /** @export */ ww_req_status: _ww_req_status,
    /** @export */ ww_self: _ww_self,
    /** @export */ ww_state: _ww_state
  };
}

// Argument name here must shadow the `wasmExports` global so
// that it is recognised by metadce and minify-import-export-names
// passes.
function applySignatureConversions(wasmExports) {
  var makeWrapper_pp = f => a0 => f(a0) >>> 0;
  var makeWrapper_p = f => () => f() >>> 0;
  var origExports = wasmExports;
  wasmExports = {};
  wasmExports["malloc"] = makeWrapper_pp(origExports["malloc"]);
  wasmExports["emscripten_stack_get_current"] = makeWrapper_p(origExports["emscripten_stack_get_current"]);
  wasmExports["_emscripten_tls_init"] = makeWrapper_p(origExports["_emscripten_tls_init"]);
  wasmExports["pthread_self"] = makeWrapper_p(origExports["pthread_self"]);
  wasmExports["_emscripten_stack_alloc"] = makeWrapper_pp(origExports["_emscripten_stack_alloc"]);
  Object.setPrototypeOf(wasmExports, origExports);
  return wasmExports;
}

// include: postamble.js
// === Auto-generated postamble setup entry stuff ===
// include: runtime_pthread.js
// Pthread Web Worker handling code.
// This code runs only on pthread web workers and handles pthread setup
// and communication with the main thread via postMessage.
var startWorker;

if (ENVIRONMENT_IS_PTHREAD) {
  // Thread-local guard variable for one-time init of the JS state
  var initializedJS = false;
  // Turn unhandled rejected promises into errors so that the main thread will be
  // notified about them.
  self.onunhandledrejection = e => {
    throw e.reason || e;
  };
  async function handleMessage(e) {
    try {
      var msgData = e.data;
      //dbg('msgData: ' + Object.keys(msgData));
      var cmd = msgData.cmd;
      if (cmd == CMD_LOAD) {
        // Preload command that is called once per worker to parse and load the Emscripten code.
        // Until we initialize the runtime, queue up any further incoming messages.
        let messageQueue = [];
        self.onmessage = e => messageQueue.push(e);
        // And add a callback for when the runtime is initialized.
        startWorker = () => {
          // Notify the main thread that this thread has loaded.
          postMessage({
            cmd: CMD_LOADED
          });
          // Process any messages that were queued before the thread was ready.
          for (let msg of messageQueue) {
            handleMessage(msg);
          }
          // Restore the real message handler.
          self.onmessage = handleMessage;
        };
        // Use `const` here to ensure that the variable is scoped only to
        // that iteration, allowing safe reference from a closure.
        for (const handler of msgData.handlers) {
          // If the main module has a handler for a certain event, but no
          // handler exists on the pthread worker, then proxy that handler
          // back to the main thread.
          if (!Module[handler] || Module[handler].proxy) {
            Module[handler] = (...args) => {
              postMessage({
                cmd: CMD_CALL_HANDLER,
                handler,
                args
              });
            };
            // Rebind the out / err handlers if needed
            if (handler == "print") out = Module[handler];
            if (handler == "printErr") err = Module[handler];
          }
        }
        wasmMemory = msgData.wasmMemory;
        updateMemoryViews();
        wasmModule = msgData.wasmModule;
        createWasm();
        run();
        startWorker();
      } else if (cmd == CMD_RUN) {
        // Call inside JS module to set up the stack frame for this pthread in JS module scope.
        // This needs to be the first thing that we do, as we cannot call to any C/C++ functions
        // until the thread stack is initialized.
        establishStackSpace(msgData.pthread_ptr);
        // Pass the thread address to wasm to store it for fast access.
        __emscripten_thread_init(msgData.pthread_ptr, /*is_main=*/ 0, /*is_runtime=*/ 0, /*can_block=*/ 1, 0, 0);
        PThread.threadInitTLS();
        // Await mailbox notifications with `Atomics.waitAsync` so we can start
        // using the fast `Atomics.notify` notification path.
        __emscripten_thread_mailbox_await(msgData.pthread_ptr);
        if (!initializedJS) {
          initializedJS = true;
        }
        try {
          await invokeEntryPoint(msgData.start_routine, msgData.arg);
        } catch (ex) {
          if (ex != "unwind") {
            // The pthread "crashed".  Do not call `_emscripten_thread_exit` (which
            // would make this thread joinable).  Instead, re-throw the exception
            // and let the top level handler propagate it back to the main thread.
            throw ex;
          }
        }
      } else if (cmd == CMD_CHECK_MAILBOX) {
        if (initializedJS) {
          checkMailbox();
        }
      } else if (cmd) {
        // The received message looks like something that should be handled by this message
        // handler, (since there is a cmd field present), but is not one of the
        // recognized commands:
        err(`worker: received unknown command ${cmd}`);
        err(msgData);
      }
    } catch (ex) {
      if (runtimeInitialized) __emscripten_thread_crashed();
      throw ex;
    }
  }
  self.onmessage = handleMessage;
}

// ENVIRONMENT_IS_PTHREAD
// end include: runtime_pthread.js
async function callMain(args = []) {
  var entryFunction = _main;
  args.unshift(thisProgram);
  var argc = args.length;
  var argv = stackAlloc((argc + 1) * 4);
  var argv_ptr = argv;
  for (var arg of args) {
    (growMemViews(), HEAPU32)[((argv_ptr) >>> 2) >>> 0] = stringToUTF8OnStack(arg);
    argv_ptr += 4;
  }
  (growMemViews(), HEAPU32)[((argv_ptr) >>> 2) >>> 0] = 0;
  try {
    var ret = entryFunction(argc, argv);
    // The current spec of JSPI returns a promise only if the function suspends
    // and a plain value otherwise. This will likely change:
    // https://github.com/WebAssembly/js-promise-integration/issues/11
    ret = await ret;
    // if we're not running an evented main loop, it's time to exit
    exitJS(ret, /* implicit = */ true);
    return ret;
  } catch (e) {
    return handleException(e);
  }
}

async function run(args = programArgs) {
  if ((ENVIRONMENT_IS_PTHREAD)) {
    initRuntime();
    return;
  }
  preRun();
  if (runDependencies) {
    await resolveRunDependencies();
  }
  var setStatus = Module["setStatus"];
  if (setStatus) {
    setStatus("Running...");
    // Yield to the event loop to allow the browser to paint "Running..."
    await new Promise(resolve => setTimeout(resolve, 1));
    // Then we want to clear the status text, but only after the rest of this function runs.
    setTimeout(setStatus, 1, "");
  }
  if (ABORT) return;
  initRuntime();
  // No ATMAINS hooks
  Module["onRuntimeInitialized"]?.();
  var noInitialRun = Module["noInitialRun"] || false;
  if (!noInitialRun) await callMain(args);
  postRun();
}

var wasmExports;

if ((!(ENVIRONMENT_IS_PTHREAD))) {
  // Call createWasm on startup if we are the main thread.
  // Worker threads call this once they receive the module via postMessage
  // With async instantation wasmExports is assigned asynchronously when the
  // instance is received.
  createWasm().then(() => run());
}
