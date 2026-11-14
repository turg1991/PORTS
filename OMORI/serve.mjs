// Static server for the OMORI web playtest build.
// Usage: node serve.mjs [port]   (default: 8000)
// Then open http://localhost:8000/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || 8000;

// Regenerate js/web_manifest.js so disk-placed mods in /mods/ are discovered by
// the loader's readdir (which reads the manifest, not the real filesystem).
try {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'gen_manifest.mjs')], { encoding: 'utf8' });
    if (r.status === 0) console.log('[manifest] ' + (r.stdout || '').trim());
    else console.warn('[manifest] regeneration failed: ' + (r.stderr || r.stdout || 'unknown'));
} catch (e) {
    console.warn('[manifest] regeneration threw: ' + e.message);
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.webm': 'video/webm',
    '.mp4': 'video/mp4',
    '.wasm': 'application/wasm',
    '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
    let urlPath;
    try {
        urlPath = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
    } catch (e) {
        res.writeHead(400); res.end('Bad request'); return;
    }
    if (urlPath.endsWith('/')) urlPath += 'index.html';

    const filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }

    fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found: ' + urlPath);
            return;
        }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Content-Length': stat.size,
            'Cache-Control': 'no-cache',
            'Accept-Ranges': 'bytes',
        });
        if (req.method === 'HEAD') { res.end(); return; }
        fs.createReadStream(filePath).pipe(res);
    });
});

server.listen(PORT, () => {
    console.log(`OMORI web build served at http://localhost:${PORT}/  (root: ${ROOT})`);
});
