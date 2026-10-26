#!/usr/bin/env node
/**
 * Turn a Twinmotion / Unreal glTF, or a Fusion OBJ+MTL, into a web GLB:
 * meters, Y-up, centered, sitting on the floor, textures capped at 2048px,
 * color maps as WebP, data maps as lossless WebP, mesh compressed.
 * A Fusion file with only a flat wood color gets a tileable semigloss grain.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { getBounds, Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  center,
  dedup,
  draco,
  listTextureSlots,
  meshopt,
  prune,
  textureCompress,
  TextureResizeFilter,
} from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

import { loadFusionObj } from './fusion-obj.mjs';

export const UNIT_IN_METERS = {
  m: 1,
  cm: 0.01,
  mm: 0.001,
  in: 0.0254,
  ft: 0.3048,
};

const UNIT_NAMES = {
  m: 'meters',
  cm: 'centimeters',
  mm: 'millimeters',
  in: 'inches',
  ft: 'feet',
};

/** -90° about X: (x, y, z) Z-up → (x, z, -y) Y-up. */
const Z_UP_TO_Y_UP = [Math.sin(-Math.PI / 4), 0, 0, Math.cos(-Math.PI / 4)];

const COLOR_SLOTS = /^(baseColorTexture|emissiveTexture|diffuseTexture)$/;
const DATA_SLOTS = /^(normalTexture|metallicRoughnessTexture|occlusionTexture|transmissionTexture|thicknessTexture|specularTexture|specularColorTexture|specularGlossinessTexture|sheenColorTexture|sheenRoughnessTexture|clearcoatTexture|clearcoatNormalTexture|clearcoatRoughnessTexture|iridescenceTexture|iridescenceThicknessTexture|anisotropyTexture|diffuseTransmissionTexture|diffuseTransmissionColorTexture)$/;

const JSDELIVR_FILE_LIMIT = 20 * 1024 * 1024;
const GIT_FILE_LIMIT = 95 * 1024 * 1024;

let ioPromise;

export function createIO() {
  ioPromise ??= buildIO();
  return ioPromise;
}

async function buildIO() {
  const [decoder, encoder] = await Promise.all([
    draco3d.createDecoderModule(),
    draco3d.createEncoderModule(),
    MeshoptDecoder.ready,
    MeshoptEncoder.ready,
  ]);
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': decoder,
    'draco3d.encoder': encoder,
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });
}

/**
 * Longest side of a world-space bounding box, in the file's current units.
 * auto treats ≤20 as meters, ≤2000 as centimeters, and anything larger as millimeters.
 */
export function detectUnits(longestSide) {
  if (!Number.isFinite(longestSide) || longestSide <= 20) return 'm';
  if (longestSide <= 2000) return 'cm';
  return 'mm';
}

export function longestSide(bounds) {
  return Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  );
}

function defaultScene(document) {
  const root = document.getRoot();
  const scene = root.getDefaultScene() || root.listScenes()[0];
  if (!scene) {
    throw new Error('This file has no scene. Export the furniture as a .glb and try again.');
  }
  return scene;
}

function boundsAreFinite(bounds) {
  return bounds.min.every(Number.isFinite) && bounds.max.every(Number.isFinite);
}

function assertUp(up) {
  if (up !== 'y' && up !== 'z') {
    throw new Error(`Unknown up axis "${up}". Use y or z.`);
  }
}

function assertUnits(units) {
  if (units !== 'auto' && !UNIT_IN_METERS[units]) {
    throw new Error(`Unknown units "${units}". Use auto, m, cm, mm, in, or ft.`);
  }
}

function assertMaxTexture(maxTexture) {
  const n = Number(maxTexture);
  if (!Number.isInteger(n) || n < 128 || n > 8192) {
    throw new Error('max texture size must be a whole number from 128 to 8192.');
  }
  return n;
}

/**
 * Scale the scene into meters and, when asked, rotate Z-up onto Y-up.
 * Does not center; call optimizeDocument for the full pipeline.
 */
export function normalizeDocument(document, { units = 'auto', up = 'y' } = {}) {
  assertUnits(units);
  assertUp(up);
  const before = getBounds(defaultScene(document));
  if (!boundsAreFinite(before)) {
    throw new Error('This file has no furniture mesh in its scene. Export the piece itself, not an empty scene.');
  }
  const longest = longestSide(before);
  const resolved = units === 'auto' ? detectUnits(longest) : units;
  const scale = UNIT_IN_METERS[resolved];

  if (up === 'z' || scale !== 1) {
    for (const scene of document.getRoot().listScenes()) {
      const wrapper = document.createNode('Normalize');
      for (const child of [...scene.listChildren()]) wrapper.addChild(child);
      if (up === 'z') wrapper.setRotation(Z_UP_TO_Y_UP);
      if (scale !== 1) wrapper.setScale([scale, scale, scale]);
      scene.addChild(wrapper);
    }
  }

  return { requestedUnits: units, units: resolved, scale, up, before, longest };
}

function stripPresentationExtras(document) {
  const root = document.getRoot();
  for (const animation of [...root.listAnimations()]) animation.dispose();
  for (const camera of [...root.listCameras()]) camera.dispose();
  for (const node of root.listNodes()) {
    const light = node.getExtension('KHR_lights_punctual');
    if (!light) continue;
    node.setExtension('KHR_lights_punctual', null);
    light.dispose();
  }
}

async function describeTexture(texture) {
  const image = texture.getImage();
  let width = null;
  let height = null;
  if (image) {
    const meta = await sharp(Buffer.from(image)).metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;
  }
  return {
    name: texture.getName() || texture.getURI() || 'texture',
    slots: listTextureSlots(texture),
    width,
    height,
    mime: texture.getMimeType(),
    bytes: image ? image.byteLength : 0,
  };
}

async function compressTextures(document, maxTexture) {
  const limit = [maxTexture, maxTexture];
  const before = new Map();
  for (const texture of document.getRoot().listTextures()) {
    before.set(texture, await describeTexture(texture));
  }

  await document.transform(
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      resize: limit,
      slots: COLOR_SLOTS,
      quality: 82,
    }),
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      resize: limit,
      slots: DATA_SLOTS,
      lossless: true,
      resizeFilter: TextureResizeFilter.LANCZOS2,
    }),
    textureCompress({
      encoder: sharp,
      resize: limit,
      formats: /image\/(png|jpe?g)/,
    }),
  );

  const textures = [];
  for (const texture of document.getRoot().listTextures()) {
    textures.push({
      before: before.get(texture) ?? null,
      after: await describeTexture(texture),
    });
  }
  return textures;
}

async function compressMesh(document, mode) {
  if (mode === 'none') return;
  if (mode === 'draco') {
    await document.transform(draco());
    return;
  }
  if (mode === 'meshopt') {
    await MeshoptEncoder.ready;
    await document.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    return;
  }
  throw new Error(`Unknown compression "${mode}". Use draco, meshopt, or none.`);
}

export async function optimizeDocument(document, options = {}) {
  document.setLogger(new Logger(Logger.Verbosity.WARN));
  const maxTexture = assertMaxTexture(options.maxTexture ?? 2048);
  const compress = options.compress ?? 'draco';
  const placement = normalizeDocument(document, options);
  stripPresentationExtras(document);
  await document.transform(
    center({ pivot: 'below' }),
    dedup(),
    prune(),
  );
  const textures = await compressTextures(document, maxTexture);
  await document.transform(prune());
  await compressMesh(document, compress);
  const after = getBounds(defaultScene(document));
  return { ...placement, after, textures, compress, maxTexture };
}

function mimeLabel(mime) {
  if (mime === 'image/webp') return 'WebP';
  if (mime === 'image/png') return 'PNG';
  if (mime === 'image/jpeg') return 'JPEG';
  return mime || 'image';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSize(bounds) {
  const wide = (bounds.max[0] - bounds.min[0]) * 100;
  const tall = (bounds.max[1] - bounds.min[1]) * 100;
  const deep = (bounds.max[2] - bounds.min[2]) * 100;
  return `${wide.toFixed(1)} cm wide × ${deep.toFixed(1)} cm deep × ${tall.toFixed(1)} cm tall`;
}

async function writePoster(posterPath, outputGlb) {
  const dest = path.join(path.dirname(outputGlb), 'poster.webp');
  const tmp = `${dest}.partial`;
  await sharp(posterPath)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(tmp);
  await fs.rename(tmp, dest);
  const stat = await fs.stat(dest);
  return { dest, bytes: stat.size };
}

function printReport(input, output, inputBytes, outputBytes, report, poster) {
  console.log(`Read ${path.basename(input)} (${formatBytes(inputBytes)}).`);
  for (const wood of report.woodSummary ?? []) {
    const color = wood.flatColor ? 'flat MTL color' : 'MTL texture';
    if (wood.species === 'leather') {
      console.log(`Leather: soft matte for "${wood.material}" (${color}, ${wood.triangles} triangles).`);
    } else {
      console.log(`Wood: ${wood.species} grain for "${wood.material}" (${color}, ${wood.triangles} triangles).`);
    }
  }
  if (report.requestedUnits === 'auto') {
    const rounded = Number(report.longest.toFixed(2));
    console.log(`Longest side is ${rounded} units. Treating that as ${UNIT_NAMES[report.units]} (×${report.scale}).`);
  } else {
    console.log(`Using ${UNIT_NAMES[report.units]} (--units ${report.units}, ×${report.scale}).`);
  }
  console.log(report.up === 'z' ? 'Rotated the model from Z-up onto Y-up.' : 'Kept Y-up.');

  if (report.textures.length === 0) {
    console.log('No textures found. If the wood and fabric should be in the file, export the .glb again with its materials.');
  } else {
    console.log(`Textures capped at ${report.maxTexture}px. Color maps are WebP. Normal and other data maps are lossless WebP.`);
    for (const texture of report.textures) {
      const name = texture.after?.name || texture.before?.name || 'texture';
      const from = texture.before;
      const to = texture.after;
      if (!from || !to) continue;
      console.log(`  ${name}: ${from.width}×${from.height} ${mimeLabel(from.mime)} → ${to.width}×${to.height} ${mimeLabel(to.mime)}`);
    }
  }

  const compression = { draco: 'Draco', meshopt: 'Meshopt', none: 'none' }[report.compress] ?? report.compress;
  console.log(`Mesh compression: ${compression}.`);
  console.log(`Wrote ${output} (${formatBytes(outputBytes)}).`);
  if (poster) console.log(`Poster: ${poster.dest} (${formatBytes(poster.bytes)}).`);
  console.log(`Finished size: ${formatSize(report.after)}.`);
  console.log('Check this against the real piece. A dining chair is usually about 90–110 cm tall. If the number is wrong, run the command again with --units m, cm, mm, in, or ft. If the piece is lying on its side, run it again with --up z.');

  const tall = (report.after.max[1] - report.after.min[1]) * 100;
  const longestCm = longestSide(report.after) * 100;
  if (tall < 15 || tall > 800 || longestCm > 800) {
    console.log('That size looks unusual for a single piece of furniture. Export only the piece, not the room, and check --units.');
  }
  if (outputBytes > GIT_FILE_LIMIT) {
    throw new Error(`The file is ${formatBytes(outputBytes)}. GitHub rejects files near 100 MB. Run again with --max-texture 1024.`);
  }
  if (outputBytes > JSDELIVR_FILE_LIMIT) {
    console.log(`This file is over 20 MB, so jsDelivr will not serve it. Run again with --max-texture 1024.`);
  }
}

const HELP = `Prepare a furniture export for the Artesão website.

Usage:
  node scripts/optimize.mjs <input> <output.glb> [options]

Input is a .glb, a .gltf, or a Fusion .obj (with its .mtl beside it).

Options:
  --units auto|m|cm|mm|in|ft   How big one unit in the file is. Default: auto.
  --up y|z                     Which axis is up in the file.
                               Default: z for .obj, y for .glb/.gltf.
  --wood auto|walnut|maple     Grain used for a flat-color Fusion material.
                               Default: auto, from the MTL name (Walnut, Maple).
  --compress draco|meshopt|none
                               Mesh compression. Default: draco.
  --max-texture <pixels>       Longest side of any texture. Default: 2048.
  --poster <image>             Also write poster.webp next to the model (max 1600px).
  -h, --help                   Show this help.

auto units, from the longest side of the file:
  up to 20        meters
  up to 2000      centimeters
  over 2000       millimeters

A Fusion OBJ is usually centimeters and Z-up, with only a flat color.
The script stands it up, scales it to meters, sits it on the floor, and
builds a tileable semigloss grain along each wood part. A material named
leather, or a flat gray or black, becomes a soft matte dark leather.

The script prints the finished size in centimeters. A dining chair is about
90–110 cm tall. If that number is wrong, run the command again with --units.
If the piece is lying on its side, run it again with --up z.

Examples:
  node scripts/optimize.mjs ~/Downloads/Windsor.glb models/windsor/windsor.glb --poster ~/Downloads/windsor.png
  node scripts/optimize.mjs "Traditional Turned Leg Chair.obj" models/traditional-turned/traditional-turned.glb
`;

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      units: { type: 'string', default: 'auto' },
      up: { type: 'string' },
      wood: { type: 'string', default: 'auto' },
      compress: { type: 'string', default: 'draco' },
      'max-texture': { type: 'string', default: '2048' },
      poster: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(HELP);
    return;
  }
  if (positionals.length !== 2) {
    console.error(HELP);
    throw new Error('Provide the input file and the output .glb path.');
  }

  const input = path.resolve(positionals[0]);
  const output = path.resolve(positionals[1]);
  if (!output.toLowerCase().endsWith('.glb')) {
    throw new Error('The output file must end in .glb so the website can load one file.');
  }
  try {
    await fs.access(input);
  } catch {
    throw new Error(`Could not find ${input}.`);
  }
  if (values.poster) {
    try {
      await fs.access(values.poster);
    } catch {
      throw new Error(`Could not find the poster image ${values.poster}.`);
    }
  }

  const inputStat = await fs.stat(input);
  const io = await createIO();
  const isObj = input.toLowerCase().endsWith('.obj');
  let document;
  let woodSummary = [];
  if (isObj) {
    const loaded = await loadFusionObj(input, { wood: values.wood });
    document = loaded.document;
    woodSummary = loaded.summaries;
  } else {
    if (values.wood !== 'auto') {
      console.log('Ignoring --wood. It applies to a Fusion OBJ with a flat material color.');
    }
    document = await io.read(input);
  }
  const report = await optimizeDocument(document, {
    units: values.units,
    up: values.up ?? (isObj ? 'z' : 'y'),
    compress: values.compress,
    maxTexture: values['max-texture'],
  });
  report.woodSummary = woodSummary;

  await fs.mkdir(path.dirname(output), { recursive: true });
  // The temporary name has to end in .glb. NodeIO packs a single binary only
  // for that extension; anything else is written as JSON plus sidecar files.
  const partial = output.replace(/\.glb$/i, '.partial.glb');
  try {
    await io.write(partial, document);
    await fs.rename(partial, output);
  } catch (error) {
    await fs.rm(partial, { force: true });
    throw error;
  }

  const outputStat = await fs.stat(output);
  const poster = values.poster ? await writePoster(path.resolve(values.poster), output) : null;
  printReport(input, output, inputStat.size, outputStat.size, report, poster);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
