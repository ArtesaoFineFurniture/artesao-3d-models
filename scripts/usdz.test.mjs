import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';

import { convertGlbToUsdz, gltfUvToUsdSt, isIdentityMatrix, transformPoint } from './glb-to-usdz.mjs';

const slugs = [
  'legacy-side',
  'legacy-arm',
  'windsor-side',
  'windsor-arm',
  'traditional-turned',
  'traditional-straight',
  'traditional-stool',
];

function zipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.subarray(offset, offset + 4).toString('latin1') === 'PK\u0003\u0004') {
    const method = buffer.readUInt16LE(offset + 8);
    const flags = buffer.readUInt16LE(offset + 6);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    entries.push({ name, method, flags, start });
    assert.equal(flags & 0x8, 0, `${name} uses a data descriptor`);
    offset = start + compressedSize;
  }
  assert.ok(entries.length > 0);
  return entries;
}

test('glTF UV origin maps onto USD', () => {
  assert.deepEqual(gltfUvToUsdSt(0, 0), [0, 1]);
  assert.deepEqual(gltfUvToUsdSt(1, 1), [1, 0]);
  assert.deepEqual(gltfUvToUsdSt(0.25, 0.5), [0.25, 0.5]);
});

test('a translation moves a point and leaves an identity matrix alone', () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  assert.equal(isIdentityMatrix(identity), true);
  const translated = identity.slice();
  translated[13] = 2;
  assert.equal(isIdentityMatrix(translated), false);
  assert.deepEqual(transformPoint(translated, 1, 0, 0), [1, 2, 0]);
});

for (const slug of slugs) {
  test(`${slug}.usdz is a 64-byte aligned Quick Look package under 20 MB`, async () => {
    const file = await readFile(`models/${slug}/${slug}.usdz`);
    assert.ok(file.length < 20 * 1024 * 1024);
    assert.ok(file.length > 10 * 1024);
    const entries = zipEntries(file);
    assert.ok(entries.some((entry) => entry.name.endsWith('.usdc') || entry.name.endsWith('.usda')));
    assert.ok(entries.some((entry) => entry.name.endsWith('.png')));
    for (const entry of entries) {
      assert.equal(entry.method, 0, `${entry.name} is compressed`);
      assert.equal(entry.start % 64, 0, `${entry.name} is not 64-byte aligned`);
    }
  });
}

test('the Windsor alias USDZ matches the side chair byte for byte', async () => {
  const alias = await readFile('models/windsor/windsor.usdz');
  const canonical = await readFile('models/windsor-side/windsor-side.usdz');
  assert.equal(alias.equals(canonical), true);
});

test('a one-metre triangle keeps its size and texture through USDZ', async () => {
  const probe = spawnSync('python3', ['-c', 'import pxr.Usd'], { encoding: 'utf8' });
  if (probe.status !== 0) return;

  const directory = await mkdtemp(path.join(tmpdir(), 'artesao-usdz-test-'));
  try {
    const document = new Document();
    const buffer = document.createBuffer();
    const positions = document.createAccessor('positions')
      .setType('VEC3')
      .setArray(new Float32Array([
        -0.25, 0, -0.2,
        0.25, 0, -0.2,
        0, 1, 0.2,
      ]))
      .setBuffer(buffer);
    const normals = document.createAccessor('normals')
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]))
      .setBuffer(buffer);
    const uvs = document.createAccessor('uvs')
      .setType('VEC2')
      .setArray(new Float32Array([0, 1, 1, 1, 0.5, 0]))
      .setBuffer(buffer);
    const indices = document.createAccessor('indices')
      .setType('SCALAR')
      .setArray(new Uint16Array([0, 1, 2]))
      .setBuffer(buffer);
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 12, g: 34, b: 56 } },
    }).png().toBuffer();
    const texture = document.createTexture('swatch').setImage(png).setMimeType('image/png');
    const material = document.createMaterial('Walnut')
      .setBaseColorTexture(texture)
      .setMetallicFactor(0)
      .setRoughnessFactor(0.4)
      .setDoubleSided(true);
    const primitive = document.createPrimitive()
      .setMode(4)
      .setIndices(indices)
      .setAttribute('POSITION', positions)
      .setAttribute('NORMAL', normals)
      .setAttribute('TEXCOORD_0', uvs)
      .setMaterial(material);
    const mesh = document.createMesh('Seat').addPrimitive(primitive);
    document.createScene('Scene').addChild(document.createNode('Seat').setMesh(mesh));

    const glbPath = path.join(directory, 'seat.glb');
    const usdzPath = path.join(directory, 'seat.usdz');
    const io = new NodeIO();
    await io.write(glbPath, document);
    const before = await readFile(glbPath);
    const report = await convertGlbToUsdz(glbPath, usdzPath);
    const after = await readFile(glbPath);
    assert.equal(after.equals(before), true);
    assert.equal(report.ok, true);
    assert.equal(report.upAxis, 'Y');
    assert.equal(report.metersPerUnit, 1);
    assert.ok(Math.abs(report.boundsMin[1]) < 0.0005);
    assert.ok(Math.abs(report.boundsMax[1] - 1) < 0.0005);
    assert.equal(report.textureCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
