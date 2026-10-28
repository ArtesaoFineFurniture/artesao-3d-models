import { CHUNK_BYTES, MAX_CHUNKS, MAX_FILE_BYTES } from './limits.mjs';
import { UNIT_IN_METERS } from './units.mjs';
import { ClientError } from './http.mjs';
import { createToken, isToken } from './token.mjs';

export function metaKey(token) {
  return `meta/${token}`;
}

export function fileKey(token, kind) {
  return `files/${token}/model.${kind}`;
}

export function chunkKey(token, kind, index) {
  return `chunks/${token}/${kind}/${index}`;
}

export function cleanName(value) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 120);
  return text || 'Untitled project';
}

function viewPath(token) {
  return `/view/${token}`;
}

function publicProject(meta) {
  return {
    token: meta.token,
    name: meta.name,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    status: meta.status,
    units: meta.units,
    sizeMeters: meta.sizeMeters,
    glbBytes: meta.glbBytes,
    usdzBytes: meta.usdzBytes,
    viewPath: viewPath(meta.token),
  };
}

async function readMeta(store, token) {
  if (!isToken(token)) return null;
  return store.get(metaKey(token), { type: 'json' });
}

export async function createProject(store, name) {
  const token = createToken();
  const now = new Date().toISOString();
  const meta = {
    token,
    name: cleanName(name),
    createdAt: now,
    updatedAt: now,
    status: 'uploading',
    units: null,
    sizeMeters: null,
    glbBytes: null,
    usdzBytes: null,
  };
  await store.setJSON(metaKey(token), meta);
  return { token, viewPath: viewPath(token) };
}

export async function writeChunk(store, token, kind, index, total, bytes) {
  if (kind !== 'glb' && kind !== 'usdz') {
    throw new ClientError(400, 'bad_request', 'Only a GLB or a USDZ can be stored.');
  }
  if (!Number.isInteger(index) || index < 0 || index >= MAX_CHUNKS) {
    throw new ClientError(400, 'bad_request', 'The upload was split incorrectly. Try again.');
  }
  if (!Number.isInteger(total) || total < 1 || total > MAX_CHUNKS || index >= total) {
    throw new ClientError(400, 'bad_request', 'The upload was split incorrectly. Try again.');
  }
  if (bytes.byteLength === 0) {
    throw new ClientError(400, 'bad_request', 'An upload part was empty. Try again.');
  }
  if (bytes.byteLength > CHUNK_BYTES) {
    throw new ClientError(413, 'too_large', 'Each upload part has to be 3 MB or smaller.');
  }
  const meta = await readMeta(store, token);
  if (!meta) throw new ClientError(404, 'not_found', 'That project is not on this site.');
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  await store.set(chunkKey(token, kind, index), copy, {
    metadata: { total: String(total), size: String(bytes.byteLength) },
  });
  return { received: bytes.byteLength };
}

async function assemble(store, token, kind, total) {
  const parts = [];
  let size = 0;
  for (let index = 0; index < total; index += 1) {
    const entry = await store.getWithMetadata(chunkKey(token, kind, index), { type: 'arrayBuffer' });
    if (!entry) {
      throw new ClientError(400, 'incomplete', `Part ${index + 1} of the ${kind.toUpperCase()} did not arrive. Try the upload again.`);
    }
    if (Number(entry.metadata?.total) !== total) {
      throw new ClientError(400, 'incomplete', 'The upload parts do not match. Try the upload again.');
    }
    const chunk = new Uint8Array(entry.data);
    size += chunk.byteLength;
    if (size > MAX_FILE_BYTES) {
      throw new ClientError(413, 'too_large', 'That model is over 18 MB. Netlify can stream a model back only up to 20 MB, so simplify the FBX and try again.');
    }
    parts.push(chunk);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function looksLikeGlb(bytes) {
  return bytes.byteLength > 20
    && bytes[0] === 0x67
    && bytes[1] === 0x6c
    && bytes[2] === 0x54
    && bytes[3] === 0x46;
}

function looksLikeUsdz(bytes) {
  return bytes.byteLength > 30
    && bytes[0] === 0x50
    && bytes[1] === 0x4b
    && bytes[2] === 0x03
    && bytes[3] === 0x04;
}

function assertSize(size) {
  const values = size && [size.x, size.y, size.z];
  const ok = values
    && values.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100)
    && Math.max(...values) > 0;
  if (!ok) {
    throw new ClientError(400, 'bad_request', 'The measured size does not look usable. Check the units and try again.');
  }
}

export async function completeProject(store, token, body) {
  const meta = await readMeta(store, token);
  if (!meta) throw new ClientError(404, 'not_found', 'That project is not on this site.');
  const glbChunks = Number(body?.glbChunks);
  const usdzChunks = Number(body?.usdzChunks);
  if (!Number.isInteger(glbChunks) || !Number.isInteger(usdzChunks) || glbChunks < 1 || usdzChunks < 1) {
    throw new ClientError(400, 'bad_request', 'The converted files did not arrive. Try the upload again.');
  }
  if (!Object.hasOwn(UNIT_IN_METERS, body?.units)) {
    throw new ClientError(400, 'bad_request', 'Choose meters, centimeters, millimeters, inches, or feet.');
  }
  assertSize(body.sizeMeters);
  const glb = await assemble(store, token, 'glb', glbChunks);
  const usdz = await assemble(store, token, 'usdz', usdzChunks);
  if (!looksLikeGlb(glb) || !looksLikeUsdz(usdz)) {
    throw new ClientError(400, 'bad_request', 'The converted files were not a GLB and a USDZ. Try the upload again.');
  }
  await store.set(fileKey(token, 'glb'), glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), {
    metadata: { contentType: 'model/gltf-binary' },
  });
  await store.set(fileKey(token, 'usdz'), usdz.buffer.slice(usdz.byteOffset, usdz.byteOffset + usdz.byteLength), {
    metadata: { contentType: 'model/vnd.usdz+zip' },
  });
  await deletePrefix(store, `chunks/${token}/`);
  const now = new Date().toISOString();
  const next = {
    ...meta,
    name: body.name === undefined ? meta.name : cleanName(body.name),
    updatedAt: now,
    status: 'ready',
    units: body.units,
    sizeMeters: { x: body.sizeMeters.x, y: body.sizeMeters.y, z: body.sizeMeters.z },
    glbBytes: glb.byteLength,
    usdzBytes: usdz.byteLength,
  };
  await store.setJSON(metaKey(token), next);
  return publicProject(next);
}

export async function listProjects(store) {
  const { blobs } = await store.list({ prefix: 'meta/' });
  const projects = [];
  for (const blob of blobs) {
    const meta = await store.get(blob.key, { type: 'json' });
    if (meta?.token && isToken(meta.token)) projects.push(publicProject(meta));
  }
  projects.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return projects;
}

export async function renameProject(store, token, name) {
  const meta = await readMeta(store, token);
  if (!meta) throw new ClientError(404, 'not_found', 'That project is not on this site.');
  const next = { ...meta, name: cleanName(name), updatedAt: new Date().toISOString() };
  await store.setJSON(metaKey(token), next);
  return publicProject(next);
}

async function deletePrefix(store, prefix) {
  const { blobs } = await store.list({ prefix });
  for (const blob of blobs) await store.delete(blob.key);
}

export async function deleteProject(store, token) {
  if (!isToken(token)) throw new ClientError(404, 'not_found', 'That project is not on this site.');
  const meta = await readMeta(store, token);
  if (!meta) throw new ClientError(404, 'not_found', 'That project is not on this site.');
  await store.delete(metaKey(token));
  await deletePrefix(store, `files/${token}/`);
  await deletePrefix(store, `chunks/${token}/`);
}

export async function readPublic(store, token) {
  const meta = await readMeta(store, token);
  if (!meta || meta.status !== 'ready') return null;
  return { name: meta.name, sizeMeters: meta.sizeMeters };
}

export async function readModel(store, token, kind) {
  if (kind !== 'glb' && kind !== 'usdz') return null;
  const meta = await readMeta(store, token);
  if (!meta || meta.status !== 'ready') return null;
  const data = await store.get(fileKey(token, kind), { type: 'arrayBuffer' });
  if (!data) return null;
  return new Uint8Array(data);
}
