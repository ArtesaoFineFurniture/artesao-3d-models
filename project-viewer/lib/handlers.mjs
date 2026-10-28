import { passwordFromRequest, passwordMatches } from './auth.mjs';
import { ClientError, clientErrorResponse, json, notFound, privacyHeaders, streamBytes } from './http.mjs';
import {
  completeProject,
  createProject,
  deleteProject,
  listProjects,
  readModel,
  readPublic,
  renameProject,
  writeChunk,
} from './projects.mjs';
import { openStore } from './store.mjs';

const MODEL_TYPES = {
  glb: 'model/gltf-binary',
  usdz: 'model/vnd.usdz+zip',
};

function authorize(request) {
  if (!process.env.ADMIN_PASSWORD) {
    throw new ClientError(503, 'admin_not_configured', 'Set ADMIN_PASSWORD in the Netlify site settings, then try again.');
  }
  if (!passwordMatches(passwordFromRequest(request))) {
    throw new ClientError(401, 'unauthorized', 'That password is not right.');
  }
}

async function readJson(request) {
  const type = request.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) return {};
  try {
    return await request.json();
  } catch {
    throw new ClientError(400, 'bad_request', 'The page sent something this site could not read.');
  }
}

async function routeAdmin(request) {
  authorize(request);
  const url = new URL(request.url);
  const pathname = url.pathname;
  const store = openStore();

  if (pathname === '/api/admin/projects') {
    if (request.method === 'GET') {
      return json(200, { projects: await listProjects(store) });
    }
    if (request.method === 'POST') {
      const body = await readJson(request);
      return json(201, await createProject(store, body.name));
    }
    return json(405, { error: 'method_not_allowed' });
  }

  let match = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/chunks\/([^/]+)\/([^/]+)$/);
  if (match) {
    if (request.method !== 'PUT') return json(405, { error: 'method_not_allowed' });
    const total = Number(request.headers.get('X-Chunk-Total'));
    const bytes = new Uint8Array(await request.arrayBuffer());
    const result = await writeChunk(store, match[1], match[2], Number(match[3]), total, bytes);
    return json(200, { ok: true, ...result });
  }

  match = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/complete$/);
  if (match) {
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const body = await readJson(request);
    return json(200, await completeProject(store, match[1], body));
  }

  match = pathname.match(/^\/api\/admin\/projects\/([^/]+)$/);
  if (match) {
    if (request.method === 'PATCH') {
      const body = await readJson(request);
      return json(200, await renameProject(store, match[1], body.name));
    }
    if (request.method === 'DELETE') {
      await deleteProject(store, match[1]);
      return json(200, { ok: true });
    }
    return json(405, { error: 'method_not_allowed' });
  }

  return notFound();
}

export async function handleAdmin(request) {
  try {
    return await routeAdmin(request);
  } catch (err) {
    if (err instanceof ClientError) return clientErrorResponse(err);
    console.error(err);
    return json(500, { error: 'server_error', message: 'Something went wrong while saving. Try again.' });
  }
}

function modelHeaders(kind, length) {
  return privacyHeaders({
    'Content-Type': MODEL_TYPES[kind],
    'Content-Length': String(length),
    'Content-Disposition': `inline; filename="model.${kind}"`,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  });
}

async function routeModel(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: privacyHeaders({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Max-Age': '86400',
      }),
    });
  }

  const view = pathname.match(/^\/api\/view\/([^/]+)$/);
  if (view) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return notFound();
    const project = await readPublic(openStore(), decodeURIComponent(view[1]));
    if (!project) return notFound();
    return json(200, project);
  }

  const file = pathname.match(/^\/m\/([^/]+)\/model\.(glb|usdz)$/);
  if (!file) return notFound();
  if (request.method !== 'GET' && request.method !== 'HEAD') return notFound();
  const bytes = await readModel(openStore(), decodeURIComponent(file[1]), file[2]);
  if (!bytes) return notFound();
  const headers = modelHeaders(file[2], bytes.byteLength);
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  // A ReadableStream is what makes Netlify treat this as a streamed response
  // (20 MB cap) instead of a buffered one (6 MB cap).
  return new Response(streamBytes(bytes), { status: 200, headers });
}

export async function handleModel(request) {
  try {
    return await routeModel(request);
  } catch (err) {
    console.error(err);
    return notFound();
  }
}
