import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleAdmin, handleModel } from '../lib/handlers.mjs';

const PUBLIC_DIR = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.fbx': 'application/octet-stream',
};

const PRIVACY = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

export async function loadEnv(file = new URL('../.env', import.meta.url)) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function insidePublic(pathname) {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const relative = decoded.replace(/^\/+/, '');
  const full = path.resolve(PUBLIC_DIR, relative);
  if (full !== PUBLIC_DIR && !full.startsWith(`${PUBLIC_DIR}${path.sep}`)) return null;
  return full;
}

async function readStatic(pathname) {
  const candidates = [];
  const full = insidePublic(pathname);
  if (!full) return null;
  candidates.push(full);
  if (pathname.endsWith('/')) candidates.push(path.join(full, 'index.html'));
  else candidates.push(path.join(full, 'index.html'));
  for (const candidate of candidates) {
    if (!candidate.startsWith(`${PUBLIC_DIR}${path.sep}`) && candidate !== PUBLIC_DIR) continue;
    try {
      const body = await readFile(candidate);
      const type = TYPES[path.extname(candidate)] || 'application/octet-stream';
      return { body, type };
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'EISDIR') throw err;
    }
  }
  return null;
}

async function sendNotFound(res) {
  const body = await readFile(path.join(PUBLIC_DIR, '404.html'));
  res.writeHead(404, { ...PRIVACY, 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

async function dispatch(req, res) {
  const host = req.headers.host || '127.0.0.1';
  const url = new URL(req.url || '/', `http://${host}`);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (key === 'host' || key === 'content-length' || key === 'connection' || key === 'transfer-encoding') continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const request = new Request(url, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });

  let response;
  if (url.pathname === '/api/admin' || url.pathname.startsWith('/api/admin/')) {
    response = await handleAdmin(request);
  } else if (url.pathname.startsWith('/api/view/') || url.pathname.startsWith('/m/')) {
    response = await handleModel(request);
  } else if (url.pathname === '/' || url.pathname === '') {
    await sendNotFound(res);
    return;
  } else if (url.pathname.startsWith('/view/')) {
    const page = await readStatic('/view/index.html');
    res.writeHead(200, { ...PRIVACY, 'Content-Type': page.type });
    res.end(page.body);
    return;
  } else {
    const file = await readStatic(url.pathname);
    if (!file) {
      await sendNotFound(res);
      return;
    }
    res.writeHead(req.method === 'HEAD' ? 200 : 200, { ...PRIVACY, 'Content-Type': file.type });
    res.end(req.method === 'HEAD' ? undefined : file.body);
    return;
  }

  const outHeaders = { ...PRIVACY };
  response.headers.forEach((value, key) => {
    outHeaders[key] = value;
  });
  res.writeHead(response.status, outHeaders);
  if (req.method === 'HEAD' || !response.body) {
    res.end();
    return;
  }
  for await (const chunk of response.body) res.write(chunk);
  res.end();
}

export function startServer({ port = 0, host = '127.0.0.1' } = {}) {
  const server = createServer((req, res) => {
    dispatch(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Something went wrong.');
    });
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      resolve({ server, url: `http://${host}:${address.port}` });
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await loadEnv();
  if (!process.env.PROJECT_VIEWER_BLOB_DIR) {
    process.env.PROJECT_VIEWER_BLOB_DIR = fileURLToPath(new URL('../.blob-data/', import.meta.url));
  }
  const port = Number(process.env.PORT) || 8888;
  const { url } = await startServer({ port });
  console.log(`Admin page: ${url}/admin`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log('Set ADMIN_PASSWORD before saving an upload. A .env file in this folder is read on startup.');
  }
}
