import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

function toBytes(value) {
  if (typeof value === 'string') return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error('Unsupported blob value');
}

function decode(bytes, type) {
  if (type === 'arrayBuffer') {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  if (type === 'json') return JSON.parse(bytes.toString('utf8'));
  if (type === 'stream') {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }
  return bytes.toString('utf8');
}

/**
 * Filesystem stand-in for Netlify Blobs, used by `npm run dev` and the tests.
 * Keys are stored as path segments. Metadata sits beside each file.
 */
export class LocalBlobStore {
  constructor(dir) {
    this.dir = dir;
  }

  fileFor(key) {
    if (typeof key !== 'string' || key.length === 0 || key.startsWith('/') || key.includes('\\')) {
      throw new Error('Invalid blob key');
    }
    const parts = key.split('/');
    if (parts.some((part) => part === '' || part === '.' || part === '..')) {
      throw new Error('Invalid blob key');
    }
    return path.join(this.dir, ...parts.map((part) => encodeURIComponent(part)));
  }

  async set(key, value, options = {}) {
    const file = this.fileFor(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, toBytes(value));
    await writeFile(`${file}.meta.json`, JSON.stringify(options.metadata ?? {}));
  }

  async setJSON(key, value, options) {
    await this.set(key, JSON.stringify(value), options);
  }

  async get(key, options = {}) {
    const entry = await this.getWithMetadata(key, options);
    return entry ? entry.data : null;
  }

  async getWithMetadata(key, options = {}) {
    const file = this.fileFor(key);
    let bytes;
    try {
      bytes = await readFile(file);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    let metadata = {};
    try {
      metadata = JSON.parse(await readFile(`${file}.meta.json`, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return { data: decode(bytes, options.type), metadata };
  }

  async delete(key) {
    const file = this.fileFor(key);
    await rm(file, { force: true });
    await rm(`${file}.meta.json`, { force: true });
  }

  async list({ prefix } = {}) {
    const blobs = [];
    await walk(this.dir, (abs) => {
      if (abs.endsWith('.meta.json')) return;
      const rel = path.relative(this.dir, abs);
      const key = rel.split(path.sep).map((part) => decodeURIComponent(part)).join('/');
      if (prefix && !key.startsWith(prefix)) return;
      blobs.push({ key });
    });
    return { blobs };
  }
}

async function walk(dir, visit) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(abs, visit);
    else visit(abs);
  }
}
