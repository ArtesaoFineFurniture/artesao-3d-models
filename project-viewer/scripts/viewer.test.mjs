import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { passwordMatches } from '../lib/auth.mjs';
import { CHUNK_BYTES as SERVER_CHUNK, MAX_FILE_BYTES as SERVER_MAX } from '../lib/limits.mjs';
import { createToken, TOKEN_BYTES } from '../lib/token.mjs';
import { UNIT_IN_METERS as SERVER_UNITS } from '../lib/units.mjs';
import { CHUNK_BYTES as CLIENT_CHUNK, MAX_FILE_BYTES as CLIENT_MAX } from '../public/js/limits.js';
import { convertFbx, detectUnits, UNIT_IN_METERS as CLIENT_UNITS } from '../public/js/convert.mjs';
import { shareUrl } from '../public/js/admin.js';
import { formatSize, modelUrls, tokenFromPath } from '../public/js/view.js';
import { buildBoxFbx, sampleStoolFbx } from './sample-fbx.mjs';
import { startServer } from './dev-server.mjs';

const PASSWORD = 'correct horse battery';
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

let server;
let base;
let blobDir;

function auth(password, extra = {}) {
  return { 'X-Admin-Password': encodeURIComponent(password), ...extra };
}

function glbBounds(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x46546c67);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  const binStart = 20 + jsonLength;
  const binLength = view.getUint32(binStart, true);
  const bin = bytes.subarray(binStart + 8, binStart + 8 + binLength);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      const accessor = json.accessors[primitive.attributes.POSITION];
      const bufferView = json.bufferViews[accessor.bufferView];
      const offset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
      const positions = new Float32Array(bin.buffer, bin.byteOffset + offset, accessor.count * 3);
      for (let i = 0; i < accessor.count; i += 1) {
        for (let axis = 0; axis < 3; axis += 1) {
          const value = positions[i * 3 + axis];
          min[axis] = Math.min(min[axis], value);
          max[axis] = Math.max(max[axis], value);
        }
      }
    }
  }
  return { min, max };
}

function usdzText(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let text = '';
  while (offset + 30 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    assert.equal(method, 0, 'USDZ entries must be stored, not deflated');
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const start = offset + 30 + nameLength + extraLength;
    text += `${new TextDecoder().decode(bytes.subarray(start, start + size))}\n`;
    offset = start + size;
  }
  assert.ok(text.length > 0);
  return text;
}

function closeTo(actual, expected, epsilon = 0.002) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);
}

async function uploadParts(token, kind, buffer, chunkSize = 700) {
  const bytes = new Uint8Array(buffer);
  const total = Math.max(1, Math.ceil(bytes.byteLength / chunkSize));
  for (let index = 0; index < total; index += 1) {
    const slice = bytes.subarray(index * chunkSize, Math.min(bytes.byteLength, (index + 1) * chunkSize));
    const response = await fetch(`${base}/api/admin/projects/${token}/chunks/${kind}/${index}`, {
      method: 'PUT',
      headers: auth(PASSWORD, {
        'Content-Type': 'application/octet-stream',
        'X-Chunk-Total': String(total),
      }),
      body: slice,
    });
    assert.equal(response.status, 200, await response.clone().text());
  }
  return total;
}

describe('private project viewer', { concurrency: 1 }, () => {
  before(async () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    blobDir = await mkdtemp(path.join(tmpdir(), 'artesao-viewer-'));
    process.env.PROJECT_VIEWER_BLOB_DIR = blobDir;
    ({ server, url: base } = await startServer({ port: 0 }));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(blobDir, { recursive: true, force: true });
  });

  test('tokens are 128 bits from crypto.getRandomValues, base64url', () => {
    const original = crypto.getRandomValues.bind(crypto);
    let calls = 0;
    crypto.getRandomValues = (bytes) => {
      calls += 1;
      assert.equal(bytes.length, TOKEN_BYTES);
      return original(bytes);
    };
    try {
      const seen = new Set();
      for (let i = 0; i < 50; i += 1) {
        const token = createToken();
        assert.match(token, /^[A-Za-z0-9_-]{22}$/);
        assert.equal(seen.has(token), false);
        seen.add(token);
      }
      assert.equal(calls, 50);
    } finally {
      crypto.getRandomValues = original;
    }
  });

  test('the password check accepts only the configured password', () => {
    assert.equal(passwordMatches(PASSWORD), true);
    assert.equal(passwordMatches('wrong'), false);
    assert.equal(passwordMatches(`${PASSWORD} `), false);
    assert.equal(passwordMatches(''), false);
    assert.equal(passwordMatches('x'.repeat(300)), false);
    const previous = process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PASSWORD;
    assert.equal(passwordMatches(PASSWORD), false);
    process.env.ADMIN_PASSWORD = previous;
  });

  test('unit thresholds match the public optimizer, and FBX headers cover inches and millimetres', () => {
    assert.deepEqual(CLIENT_UNITS, SERVER_UNITS);
    assert.equal(CLIENT_CHUNK, SERVER_CHUNK);
    assert.equal(CLIENT_MAX, SERVER_MAX);
    assert.equal(detectUnits(20), 'm');
    assert.equal(detectUnits(20.01), 'cm');
    assert.equal(detectUnits(2000), 'cm');
    assert.equal(detectUnits(2000.01), 'mm');
  });

  test('an FBX becomes a metre-scale GLB and a Quick Look USDZ on the floor', async () => {
    const fixture = await readFile(new URL('../fixtures/sample-stool.fbx', import.meta.url));
    assert.deepEqual(Buffer.from(fixture), Buffer.from(sampleStoolFbx()));
    const stool = await convertFbx(sampleStoolFbx());
    assert.equal(stool.units, 'cm');
    assert.equal(stool.unitSource, 'file');
    closeTo(stool.sizeMeters.x, 0.5);
    closeTo(stool.sizeMeters.y, 0.9);
    closeTo(stool.sizeMeters.z, 0.44);
    closeTo(stool.floor.minY, 0, 1e-4);
    closeTo(stool.floor.centerX, 0, 1e-4);
    closeTo(stool.floor.centerZ, 0, 1e-4);
    const bounds = glbBounds(stool.glb);
    closeTo(bounds.min[1], 0, 1e-3);
    closeTo(bounds.max[1] - bounds.min[1], 0.9);
    closeTo((bounds.min[0] + bounds.max[0]) / 2, 0, 1e-3);
    closeTo((bounds.min[2] + bounds.max[2]) / 2, 0, 1e-3);
    const usda = usdzText(stool.usdz);
    assert.match(usda, /metersPerUnit = 1/);
    assert.match(usda, /upAxis = "Y"/);
    assert.match(usda, /preliminary:anchoring:type = "plane"/);
    assert.match(usda, /preliminary:planeAnchoring:alignment = "horizontal"/);
    assert.match(usda, /0\.9000000/);
    assert.match(usda, /0\.2500000/);

    const standing = await convertFbx(buildBoxFbx({
      width: 50, depth: 44, height: 90, unitScaleFactor: 1, upAxis: 2,
    }));
    closeTo(standing.sizeMeters.y, 0.9);
    closeTo(standing.floor.minY, 0, 1e-4);

    const inches = await convertFbx(buildBoxFbx({
      width: 20, depth: 18, height: 40, unitScaleFactor: 2.54, upAxis: 1,
    }));
    assert.equal(inches.units, 'in');
    closeTo(inches.sizeMeters.y, 40 * 0.0254);

    const millimetres = await convertFbx(buildBoxFbx({
      width: 500, depth: 440, height: 900, unitScaleFactor: 0.1, upAxis: 1,
    }));
    assert.equal(millimetres.units, 'mm');
    closeTo(millimetres.sizeMeters.y, 0.9);

    const guessed = await convertFbx(buildBoxFbx({
      width: 50, depth: 44, height: 90, unitScaleFactor: 7, upAxis: 1,
    }));
    assert.equal(guessed.units, 'cm');
    assert.equal(guessed.unitSource, 'size');
  });

  test('uploads stay private, chunked storage round-trips, and unknown links are a generic not-found', async () => {
    const viewerHtml = await readFile(new URL('../public/view/index.html', import.meta.url), 'utf8');
    const snippet = await readFile(path.join(repoRoot, 'embed/windsor-side-snippet.html'), 'utf8');
    for (const piece of [
      'https://ajax.googleapis.com/ajax/libs/model-viewer/4.3.1/model-viewer.min.js',
      'ar-modes="webxr scene-viewer quick-look"',
      'ar-scale="fixed"',
      'ar-placement="floor"',
      'View in your room',
      'camera-orbit="35deg 78deg auto"',
      'shadow-intensity="1"',
      'Drag to rotate · Pinch or scroll to zoom',
    ]) {
      assert.ok(snippet.includes(piece), piece);
      assert.ok(viewerHtml.includes(piece), piece);
    }
    assert.match(viewerHtml, /\sar[\s>]/);
    const workflow = await readFile(path.join(repoRoot, '.github/workflows/pages.yml'), 'utf8');
    assert.match(workflow, /paths-ignore:/);
    assert.match(workflow, /project-viewer\/\*\*/);
    assert.match(workflow, /project-viewer must not be published/);
    assert.doesNotMatch(workflow, /cp -R project-viewer/);
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const adminHtml = await readFile(new URL('../public/admin/index.html', import.meta.url), 'utf8');
    assert.ok(adminHtml.includes(`three@${pkg.dependencies.three}/`));

    const refused = await fetch(`${base}/api/admin/projects`, {
      method: 'POST',
      headers: auth('nope', { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: 'Should not exist' }),
    });
    assert.equal(refused.status, 401);
    assert.equal((await refused.text()).includes('Should not exist'), false);

    const stool = await convertFbx(sampleStoolFbx());
    const created = await fetch(`${base}/api/admin/projects`, {
      method: 'POST',
      headers: auth(PASSWORD, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: 'API stool' }),
    });
    assert.equal(created.status, 201);
    const { token } = await created.json();
    assert.match(token, /^[A-Za-z0-9_-]{22}$/);
    const glbChunks = await uploadParts(token, 'glb', stool.glb);
    const usdzChunks = await uploadParts(token, 'usdz', stool.usdz);
    assert.ok(glbChunks > 1);
    assert.ok(usdzChunks > 1);
    const done = await fetch(`${base}/api/admin/projects/${token}/complete`, {
      method: 'POST',
      headers: auth(PASSWORD, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        name: 'API stool',
        units: stool.units,
        sizeMeters: stool.sizeMeters,
        glbChunks,
        usdzChunks,
      }),
    });
    assert.equal(done.status, 200, await done.clone().text());

    const glb = await fetch(`${base}/m/${token}/model.glb`);
    const usdz = await fetch(`${base}/m/${token}/model.usdz`);
    assert.equal(glb.status, 200);
    assert.equal(glb.headers.get('content-type'), 'model/gltf-binary');
    assert.equal(usdz.headers.get('content-type'), 'model/vnd.usdz+zip');
    assert.match(glb.headers.get('x-robots-tag'), /noindex/);
    assert.equal(glb.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(Buffer.from(await glb.arrayBuffer()), Buffer.from(stool.glb));
    assert.deepEqual(Buffer.from(await usdz.arrayBuffer()), Buffer.from(stool.usdz));

    const meta = await fetch(`${base}/api/view/${token}`);
    assert.equal(meta.status, 200);
    assert.equal((await meta.json()).name, 'API stool');
    const urls = modelUrls(base, token);
    assert.equal(urls.glb, `${base}/m/${token}/model.glb`);
    assert.equal(urls.usdz, `${base}/m/${token}/model.usdz`);
    assert.equal(shareUrl(base, token), `${base}/view/${token}`);
    assert.equal(formatSize(stool.sizeMeters).includes('90.0 cm tall'), true);

    const missingToken = 'a'.repeat(22);
    const missing = await fetch(`${base}/api/view/${missingToken}`);
    const malformed = await fetch(`${base}/api/view/nope`);
    assert.equal(missing.status, 404);
    assert.equal(malformed.status, 404);
    assert.equal(await missing.text(), await malformed.text());
    assert.equal((await fetch(`${base}/m/${missingToken}/model.glb`)).status, 404);
    assert.equal((await fetch(`${base}/m/nope/model.usdz`)).status, 404);

    const hidden = await fetch(`${base}/api/admin/projects`);
    assert.equal(hidden.status, 401);
    assert.equal((await hidden.text()).includes('API stool'), false);
    const listed = await fetch(`${base}/api/admin/projects`, { headers: auth(PASSWORD) });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).projects.some((project) => project.name === 'API stool'), true);

    const renamed = await fetch(`${base}/api/admin/projects/${token}`, {
      method: 'PATCH',
      headers: auth(PASSWORD, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: 'Renamed stool' }),
    });
    assert.equal(renamed.status, 200);
    assert.equal((await (await fetch(`${base}/api/view/${token}`)).json()).name, 'Renamed stool');

    const root = await fetch(`${base}/`);
    assert.equal(root.status, 404);
    const rootText = await root.text();
    assert.match(rootText, /This page is not available/);
    assert.equal(rootText.includes('/admin'), false);
    assert.equal(rootText.includes('Renamed stool'), false);
    const robots = await fetch(`${base}/robots.txt`);
    assert.equal(robots.status, 200);
    assert.match(await robots.text(), /Disallow:\s*\//);
    assert.match(robots.headers.get('x-robots-tag'), /noindex/);
    const page = await fetch(`${base}/view/${token}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /ar-modes="webxr scene-viewer quick-look"/);
    assert.equal(tokenFromPath(`/view/${token}`), token);
    assert.equal(tokenFromPath('/view/nope'), null);
    assert.equal(tokenFromPath('/view/a/b'), null);

    const tooBig = new Uint8Array(SERVER_CHUNK + 1);
    const createdBig = await fetch(`${base}/api/admin/projects`, {
      method: 'POST',
      headers: auth(PASSWORD, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: 'Too big' }),
    });
    const big = await createdBig.json();
    const rejected = await fetch(`${base}/api/admin/projects/${big.token}/chunks/glb/0`, {
      method: 'PUT',
      headers: auth(PASSWORD, { 'Content-Type': 'application/octet-stream', 'X-Chunk-Total': '1' }),
      body: tooBig,
    });
    assert.equal(rejected.status, 413);

    const previous = process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PASSWORD;
    const unconfigured = await fetch(`${base}/api/admin/projects`, { headers: auth(PASSWORD) });
    process.env.ADMIN_PASSWORD = previous;
    assert.equal(unconfigured.status, 503);

    await fetch(`${base}/api/admin/projects/${big.token}`, { method: 'DELETE', headers: auth(PASSWORD) });
    const removed = await fetch(`${base}/api/admin/projects/${token}`, { method: 'DELETE', headers: auth(PASSWORD) });
    assert.equal(removed.status, 200);
    assert.equal((await fetch(`${base}/api/view/${token}`)).status, 404);
    assert.equal((await fetch(`${base}/m/${token}/model.glb`)).status, 404);
  });

  test('the admin page converts an FBX and the viewer opens that link', { timeout: 120000 }, async () => {
    const puppeteer = await import('puppeteer-core');
    const fixture = fileURLToPath(new URL('../fixtures/sample-stool.fbx', import.meta.url));
    const browser = await puppeteer.default.launch({
      executablePath: '/usr/bin/google-chrome',
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader'],
    });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(60000);
      await page.setViewport({ width: 1280, height: 900 });
      await mkdir('/tmp/project-viewer-proof', { recursive: true });
      await page.goto(`${base}/admin`, { waitUntil: 'domcontentloaded' });
      assert.equal(await page.$eval('#workspace', (el) => el.hidden), true);
      await page.type('#password', PASSWORD);
      await page.click('#gate-form button');
      await page.waitForSelector('#workspace:not([hidden])');
      const before = await page.content();
      assert.equal(before.includes('Browser stool'), false);
      await page.$eval('#name', (el) => { el.value = 'Browser stool'; });
      const input = await page.$('#file');
      await input.uploadFile(fixture);
      await page.waitForFunction(() => {
        const status = document.getElementById('status').textContent;
        return status.includes('90.0 cm tall') && document.getElementById('save').disabled === false;
      });
      await page.click('#save');
      await page.waitForSelector('#result:not([hidden])');
      const link = await page.$eval('#share', (el) => el.value);
      assert.match(link, /\/view\/[A-Za-z0-9_-]{22}$/);
      await page.waitForFunction(() => [...document.querySelectorAll('#list input')].some((el) => el.value.includes('Browser stool')));
      await page.screenshot({ path: '/tmp/project-viewer-proof/admin.png', fullPage: true });

      const viewer = await browser.newPage();
      viewer.setDefaultTimeout(60000);
      await viewer.setViewport({ width: 1280, height: 900 });
      await viewer.goto(link, { waitUntil: 'domcontentloaded' });
      await viewer.waitForFunction(() => {
        const el = document.querySelector('model-viewer');
        return el
          && el.getAttribute('src')
          && el.getAttribute('ios-src')
          && document.getElementById('stage').hidden === false;
      });
      const attrs = await viewer.$eval('model-viewer', (el) => ({
        src: el.getAttribute('src'),
        iosSrc: el.getAttribute('ios-src'),
        ar: el.hasAttribute('ar'),
        modes: el.getAttribute('ar-modes'),
        scale: el.getAttribute('ar-scale'),
        placement: el.getAttribute('ar-placement'),
        button: el.querySelector('button').textContent,
      }));
      assert.equal(attrs.ar, true);
      assert.equal(attrs.modes, 'webxr scene-viewer quick-look');
      assert.equal(attrs.scale, 'fixed');
      assert.equal(attrs.placement, 'floor');
      assert.equal(attrs.button, 'View in your room');
      assert.match(attrs.src, /\/m\/[A-Za-z0-9_-]{22}\/model\.glb$/);
      assert.match(attrs.iosSrc, /\/m\/[A-Za-z0-9_-]{22}\/model\.usdz$/);
      assert.equal(await viewer.$eval('#name', (el) => el.textContent), 'Browser stool');
      await viewer.screenshot({ path: '/tmp/project-viewer-proof/viewer.png', fullPage: true });

      const missing = await browser.newPage();
      await missing.goto(`${base}/view/${'b'.repeat(22)}`, { waitUntil: 'domcontentloaded' });
      await missing.waitForSelector('#missing:not([hidden])');
      assert.equal(await missing.$eval('#stage', (el) => el.hidden), true);
      assert.match(await missing.$eval('#missing', (el) => el.textContent), /This page is not available/);
    } finally {
      await browser.close();
    }
  });
});
