import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Document, getBounds } from '@gltf-transform/core';
import sharp from 'sharp';

import { createIO, detectUnits, optimizeDocument } from './optimize.mjs';

const scriptPath = fileURLToPath(new URL('./optimize.mjs', import.meta.url));

function boundsSize(bounds) {
  return [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
}

async function patternPng(width, height, pixel) {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const offset = (y * width + x) * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

function addTriangle(document, positions) {
  const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer();
  const position = document.createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array(positions))
    .setBuffer(buffer);
  const indices = document.createAccessor()
    .setType('SCALAR')
    .setArray(new Uint16Array([0, 1, 2]))
    .setBuffer(buffer);
  const primitive = document.createPrimitive()
    .setAttribute('POSITION', position)
    .setIndices(indices);
  const mesh = document.createMesh().addPrimitive(primitive);
  const node = document.createNode().setMesh(mesh);
  const scene = document.getRoot().getDefaultScene() ?? document.createScene();
  scene.addChild(node);
  document.getRoot().setDefaultScene(scene);
  return { primitive, scene };
}

test('detectUnits uses meters, centimeters, then millimeters', () => {
  assert.equal(detectUnits(1.02), 'm');
  assert.equal(detectUnits(20), 'm');
  assert.equal(detectUnits(20.01), 'cm');
  assert.equal(detectUnits(102), 'cm');
  assert.equal(detectUnits(2000), 'cm');
  assert.equal(detectUnits(2000.01), 'mm');
});

test('a shifted centimeter Z-up model is scaled, stood up, centered, and floored', async () => {
  const document = new Document();
  // AABB is 60 × 65 × 102 cm, Z-up, sitting away from the origin.
  addTriangle(document, [
    10, 10, 5,
    70, 75, 5,
    40, 40, 107,
  ]);
  const png = await patternPng(3000, 32, (x, y) => [40 + (x % 180), 30 + (y % 40), 20]);
  const normal = await patternPng(2300, 32, (x) => [128, 100 + (x % 80), 255]);
  const color = document.createTexture('wood').setImage(png).setMimeType('image/png');
  const normalMap = document.createTexture('woodNormal').setImage(normal).setMimeType('image/png');
  const material = document.createMaterial('walnut')
    .setBaseColorTexture(color)
    .setNormalTexture(normalMap);
  document.getRoot().listMeshes()[0].listPrimitives()[0].setMaterial(material);

  const report = await optimizeDocument(document, {
    units: 'auto',
    up: 'z',
    compress: 'none',
    maxTexture: 2048,
  });

  const bounds = getBounds(document.getRoot().getDefaultScene());
  const [width, height, depth] = boundsSize(bounds);
  assert.ok(Math.abs(width - 0.6) < 1e-3, `width ${width}`);
  assert.ok(Math.abs(height - 1.02) < 1e-3, `height ${height}`);
  assert.ok(Math.abs(depth - 0.65) < 1e-3, `depth ${depth}`);
  assert.ok(Math.abs(bounds.min[1]) < 1e-4, `floor ${bounds.min[1]}`);
  assert.ok(Math.abs((bounds.min[0] + bounds.max[0]) / 2) < 1e-4, 'centered on X');
  assert.ok(Math.abs((bounds.min[2] + bounds.max[2]) / 2) < 1e-4, 'centered on Z');
  assert.equal(report.units, 'cm');
  assert.equal(document.getRoot().listTextures().length, 2);

  for (const texture of document.getRoot().listTextures()) {
    const meta = await sharp(Buffer.from(texture.getImage())).metadata();
    assert.equal(meta.format, 'webp', texture.getName());
    assert.ok(meta.width <= 2048 && meta.height <= 2048, `${texture.getName()} ${meta.width}x${meta.height}`);
    assert.equal(Math.max(meta.width, meta.height), 2048, texture.getName());
  }
});

test('a meter Y-up model keeps its scale and is sat on the floor', async () => {
  const document = new Document();
  addTriangle(document, [
    -0.3, 5, -0.325,
    0.3, 6.02, 0.325,
    0, 5.4, 0,
  ]);
  const report = await optimizeDocument(document, {
    units: 'auto',
    up: 'y',
    compress: 'none',
  });
  const bounds = getBounds(document.getRoot().getDefaultScene());
  const [width, height, depth] = boundsSize(bounds);
  assert.equal(report.units, 'm');
  assert.equal(report.scale, 1);
  assert.ok(Math.abs(width - 0.6) < 1e-4, `width ${width}`);
  assert.ok(Math.abs(height - 1.02) < 1e-4, `height ${height}`);
  assert.ok(Math.abs(depth - 0.65) < 1e-4, `depth ${depth}`);
  assert.ok(Math.abs(bounds.min[1]) < 1e-4, `floor ${bounds.min[1]}`);
});

test('explicit meters are not guessed again', async () => {
  const document = new Document();
  addTriangle(document, [0, 0, 0, 102, 0, 0, 0, 10, 0]);
  const report = await optimizeDocument(document, { units: 'm', up: 'y', compress: 'none' });
  const height = report.after.max[1] - report.after.min[1];
  assert.equal(report.units, 'm');
  assert.ok(Math.abs(height - 10) < 1e-4, `height ${height}`);
});

test('draco and meshopt files declare their compression extensions', async () => {
  const io = await createIO();
  for (const compress of ['draco', 'meshopt']) {
    const document = new Document();
    addTriangle(document, [-0.3, 0, -0.3, 0.3, 1, 0.3, 0, 0.4, 0]);
    await optimizeDocument(document, { units: 'm', up: 'y', compress });
    const glb = Buffer.from(await io.writeBinary(document));
    const marker = compress === 'draco' ? 'KHR_draco_mesh_compression' : 'EXT_meshopt_compression';
    assert.ok(glb.includes(marker), compress);
  }
});

test('the command writes a floored glb and a poster', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'artesao-optimize-'));
  try {
    const document = new Document();
    addTriangle(document, [
      10, 10, 5,
      70, 75, 5,
      40, 40, 107,
    ]);
    const io = await createIO();
    const input = path.join(directory, 'source.glb');
    const output = path.join(directory, 'windsor.glb');
    const poster = path.join(directory, 'shot.png');
    await io.write(input, document);
    await writeFile(poster, await sharp({
      create: { width: 2400, height: 1800, channels: 3, background: { r: 200, g: 190, b: 180 } },
    }).png().toBuffer());

    const result = spawnSync(process.execPath, [
      scriptPath,
      input,
      output,
      '--units', 'cm',
      '--up', 'z',
      '--compress', 'draco',
      '--poster', poster,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    assert.match(result.stdout, /102\.0 cm tall/);
    assert.match(result.stdout, /Draco/);
    const written = await readFile(output);
    assert.equal(written.subarray(0, 4).toString('ascii'), 'glTF');
    assert.ok(written.includes('KHR_draco_mesh_compression'));
    const posterMeta = await sharp(path.join(directory, 'poster.webp')).metadata();
    assert.equal(posterMeta.format, 'webp');
    assert.ok(posterMeta.width <= 1600 && posterMeta.height <= 1600);
    assert.equal(Math.max(posterMeta.width, posterMeta.height), 1600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
