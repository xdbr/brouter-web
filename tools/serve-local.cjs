// Serve the frontend and forward routing exclusively to our own backend.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workspace = path.resolve(root, '..');
const backendSource = fs.existsSync(path.join(workspace, 'backend', 'misc', 'profiles2'))
    ? path.join(workspace, 'backend')
    : path.join(workspace, '.local/brouter/source');
const profiles = path.resolve(process.env.PROFILES_DIR || path.join(backendSource, 'misc/profiles2'));
const backend = new URL(process.env.BROUTER_URL || 'http://127.0.0.1:17777');
if (backend.protocol !== 'http:') throw new Error('BROUTER_URL must use HTTP.');
const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.brf': 'text/plain; charset=utf-8',
};

http.createServer((req, res) => {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch (err) {
        res.writeHead(400).end('Invalid URL');
        return;
    }
    if (pathname === '/brouter' || pathname === '/brouter/batch' || /^\/brouter\/profile(?:\/[^/]+)?$/.test(pathname)) {
        const headers = { ...req.headers, host: backend.host };
        delete headers.origin;
        const upstream = http.request(
            {
                hostname: backend.hostname,
                port: backend.port || 80,
                path: req.url,
                method: req.method,
                headers,
            },
            (incoming) => {
                res.writeHead(incoming.statusCode, incoming.headers);
                incoming.pipe(res);
            }
        );
        upstream.on('error', () => {
            if (!res.headersSent) res.writeHead(502);
            res.end('Local BRouter is unavailable. Start it with npm run backend:up.');
        });
        res.on('close', () => upstream.destroy());
        req.pipe(upstream);
        return;
    }

    const profilePath = pathname.match(/^\/(?:brouter\/)?profiles2\/(.*)$/);
    const base = profilePath ? profiles : root;
    const relative = profilePath ? profilePath[1] : pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.resolve(base, relative);
    if (!file.startsWith(base + path.sep) || relative.split('/').some((part) => part.startsWith('.'))) {
        res.writeHead(403).end('Forbidden');
        return;
    }
    fs.readFile(file, (err, data) => {
        if (err) {
            res.writeHead(404).end('Not found');
            return;
        }
        res.writeHead(200, {
            'content-type': types[path.extname(file)] || 'application/octet-stream',
            'cache-control': 'no-store',
        });
        res.end(data);
    });
}).listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
    console.log('BRouter-Web: http://127.0.0.1:' + (process.env.PORT || 3000));
    console.log('Routing backend: ' + backend.origin + ' (no external fallback)');
});
