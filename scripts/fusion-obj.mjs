/**
 * Read an Autodesk Fusion OBJ + MTL (flat wood color, centimeters, Z-up)
 * and build a glTF document with a tileable semigloss wood material.
 * Grain runs along each part. The optimizer then scales to meters and Y-up.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Document, TextureInfo } from '@gltf-transform/core';
import sharp from 'sharp';

const TILE_CM = 14;
/** One repeat of the photographic walnut plank, in centimeters. */
const WOOD_TILE_CM = 42;
const LEATHER_TILE_CM = 18;

const TEXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'textures');

const WALNUT_STAINS = {
  warm: { dark: [54, 32, 16], light: [150, 104, 58] },
  grey: { dark: [46, 40, 34], light: [132, 118, 102] },
};

const SPECIES = {
  walnut: {
    light: [146, 96, 52],
    dark: [58, 34, 16],
    pore: [28, 16, 8],
    ray: [168, 122, 74],
  },
  maple: {
    light: [236, 214, 184],
    mid: [214, 184, 148],
    dark: [168, 132, 96],
    line: [120, 86, 54],
  },
};

export function woodSpeciesFromName(name) {
  const text = String(name || '').toLowerCase();
  if (text.includes('maple')) return 'maple';
  if (text.includes('walnut')) return 'walnut';
  return null;
}

export function speciesFromKd(kd) {
  if (!kd) return 'walnut';
  const luma = 0.3 * kd[0] + 0.59 * kd[1] + 0.11 * kd[2];
  return luma > 0.45 ? 'maple' : 'walnut';
}

/** Leather when the MTL says so, or when the flat color is a neutral gray or black. */
export function materialFinish(name, kd) {
  const text = String(name || '').toLowerCase();
  if (/leather|ultraleather|upholster|vinyl/.test(text)) return 'leather';
  const named = woodSpeciesFromName(name);
  if (named) return named;
  if (kd && kd.every((channel) => Number.isFinite(channel))) {
    const chroma = Math.max(...kd) - Math.min(...kd);
    if (chroma < 0.06) return 'leather';
  }
  return speciesFromKd(kd);
}

function resolveSpecies(requested, materialName, kd) {
  if (requested && requested !== 'auto') {
    if (!SPECIES[requested]) {
      throw new Error(`Unknown wood "${requested}". Use auto, walnut, or maple.`);
    }
    return requested;
  }
  return woodSpeciesFromName(materialName) ?? speciesFromKd(kd);
}

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function hash2(ix, iy, seed) {
  let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1440662683);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(u, v, cellsU, cellsV, seed) {
  const x = u * cellsU;
  const y = v * cellsV;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = fade(x - x0);
  const ty = fade(y - y0);
  const wrap = (i, cells) => ((i % cells) + cells) % cells;
  const n00 = hash2(wrap(x0, cellsU), wrap(y0, cellsV), seed);
  const n10 = hash2(wrap(x0 + 1, cellsU), wrap(y0, cellsV), seed);
  const n01 = hash2(wrap(x0, cellsU), wrap(y0 + 1, cellsV), seed);
  const n11 = hash2(wrap(x0 + 1, cellsU), wrap(y0 + 1, cellsV), seed);
  const nx0 = n00 + (n10 - n00) * tx;
  const nx1 = n01 + (n11 - n01) * tx;
  return nx0 + (nx1 - nx0) * ty;
}

function fbm(u, v, seed) {
  let sum = 0;
  let amp = 0.55;
  let norm = 0;
  let cells = 3;
  for (let octave = 0; octave < 5; octave += 1) {
    sum += amp * valueNoise(u, v, cells, cells, seed + octave * 17);
    norm += amp;
    amp *= 0.5;
    cells *= 2;
  }
  return sum / norm;
}

function smoothstep(edge0, edge1, value) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function mix3(a, b, t) {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function sampleWood(species, u, v) {
  const warp = (fbm(u, v, 2) - 0.5) * 0.22 + (valueNoise(u, v, 4, 2, 8) - 0.5) * 0.16;
  const across = u + warp;
  if (species === 'maple') {
    const fine = Math.sin((across * 22) * Math.PI * 2);
    const fineMask = smoothstep(0.62, 0.94, fine * 0.5 + 0.5);
    const phase = Math.sin(u * Math.PI * 2) * 0.22 + (fbm(u, v, 5) - 0.5) * 0.12;
    const tight = Math.sin((v * 7 + phase) * Math.PI * 2);
    const broad = Math.sin((v * 2 + phase * 0.5) * Math.PI * 2);
    const figure = tight * 0.72 + broad * 0.28;
    const band = figure * 0.5 + 0.5;
    const palette = SPECIES.maple;
    let rgb = mix3(palette.mid, palette.light, 0.25 + band * 0.75);
    rgb = mix3(rgb, palette.dark, (1 - band) * 0.28);
    rgb = mix3(rgb, palette.line, fineMask * 0.22);
    const height = figure * 0.22 - fineMask * 0.35;
    const roughness = mix(72, 128, (1 - band) * 0.65 + fineMask * 0.35);
    return { rgb, height, roughness };
  }
  const rings = Math.sin((across * 9) * Math.PI * 2 + (fbm(u, v, 4) - 0.5) * 1.6);
  const rings2 = Math.sin((across * 23) * Math.PI * 2);
  const late = smoothstep(0.15, 0.78, rings * 0.5 + 0.5);
  const late2 = smoothstep(0.55, 0.92, rings2 * 0.5 + 0.5);
  const poreRow = smoothstep(0.84, 0.98, Math.sin(across * 42 * Math.PI * 2) * 0.5 + 0.5);
  const poreDash = smoothstep(0.25, 0.75, valueNoise(u, v, 6, 28, 21));
  const pore = poreRow * poreDash * (0.3 + late * 0.7);
  const ray = smoothstep(0.78, 0.96, valueNoise(u, v, 10, 3, 11));
  const palette = SPECIES.walnut;
  let rgb = mix3(palette.light, palette.dark, late * 0.82 + late2 * 0.18);
  rgb = mix3(rgb, palette.pore, pore * 0.7);
  rgb = mix3(rgb, palette.ray, ray * (1 - late) * 0.45);
  const height = (1 - late) * 0.28 - pore * 0.55 + ray * 0.12;
  const roughness = mix(70, 142, late * 0.62 + pore * 0.38);
  return { rgb, height, roughness };
}

function sampleLeather(u, v) {
  const macro = fbm(u, v, 3);
  const pebble = valueNoise(u, v, 46, 46, 9);
  const fine = valueNoise(u, v, 92, 92, 4);
  const grain = smoothstep(0.42, 0.82, pebble);
  const deep = [158, 160, 146];
  const hide = [196, 198, 184];
  const napColor = [214, 214, 200];
  let rgb = mix3(deep, hide, 0.42 + macro * 0.46);
  rgb = mix3(rgb, napColor, grain * 0.35);
  rgb = mix3(rgb, deep, (1 - fine) * 0.08);
  const height = (pebble - 0.5) * 0.12 + (fine - 0.5) * 0.04;
  const roughness = mix(214, 240, 0.75 + (1 - grain) * 0.25);
  return { rgb, height, roughness };
}

async function mapsFromSamples(sampleAt, size, strength) {
  const color = Buffer.alloc(size * size * 3);
  const rough = Buffer.alloc(size * size * 3);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const sample = sampleAt(x / size, v);
      const index = y * size + x;
      height[index] = sample.height;
      const offset = index * 3;
      color[offset] = clampByte(sample.rgb[0]);
      color[offset + 1] = clampByte(sample.rgb[1]);
      color[offset + 2] = clampByte(sample.rgb[2]);
      rough[offset + 1] = clampByte(sample.roughness);
    }
  }

  const normal = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const ym = (y - 1 + size) % size;
      const yp = (y + 1) % size;
      const hL = height[y * size + xm];
      const hR = height[y * size + xp];
      const hU = height[ym * size + x];
      const hD = height[yp * size + x];
      let nx = (hL - hR) * strength;
      let ny = (hU - hD) * strength;
      let nz = 1;
      const length = Math.hypot(nx, ny, nz);
      nx /= length;
      ny /= length;
      nz /= length;
      const offset = (y * size + x) * 3;
      normal[offset] = clampByte(nx * 127.5 + 128);
      normal[offset + 1] = clampByte(ny * 127.5 + 128);
      normal[offset + 2] = clampByte(nz * 127.5 + 128);
    }
  }

  const raw = { width: size, height: size, channels: 3 };
  const [colorPng, normalPng, roughPng] = await Promise.all([
    sharp(color, { raw }).png().toBuffer(),
    sharp(normal, { raw }).png().toBuffer(),
    sharp(rough, { raw }).png().toBuffer(),
  ]);
  return { colorPng, normalPng, roughPng, size };
}

export async function generateWoodMaps({ species, size = 1024 }) {
  const strength = species === 'maple' ? 1.6 : 2.4;
  return mapsFromSamples((u, v) => sampleWood(species, u, v), size, strength);
}

export async function generateLeatherMaps({ size = 1024 } = {}) {
  return mapsFromSamples(sampleLeather, size, 0.55);
}

const walnutCache = new Map();

/**
 * Photographic walnut plank from the v2 viewer, recoloured to a stain.
 * Grain runs vertically in the image, which is the V axis of the part UVs.
 */
export async function walnutMapsForStain(stain = 'warm') {
  const key = WALNUT_STAINS[stain] ? stain : 'warm';
  if (walnutCache.has(key)) return walnutCache.get(key);
  const palette = WALNUT_STAINS[key];
  const { data, info } = await sharp(path.join(TEXTURE_DIR, 'walnut-basecolor.jpg'))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let lumaMin = Infinity;
  let lumaMax = -Infinity;
  const luma = new Float32Array(info.width * info.height);
  for (let i = 0, p = 0; i < data.length; i += 3, p += 1) {
    const value = data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
    luma[p] = value;
    lumaMin = Math.min(lumaMin, value);
    lumaMax = Math.max(lumaMax, value);
  }
  const span = lumaMax - lumaMin || 1;
  const graded = Buffer.alloc(data.length);
  for (let i = 0, p = 0; i < data.length; i += 3, p += 1) {
    const t = (luma[p] - lumaMin) / span;
    const rgb = mix3(palette.dark, palette.light, t);
    graded[i] = clampByte(rgb[0]);
    graded[i + 1] = clampByte(rgb[1]);
    graded[i + 2] = clampByte(rgb[2]);
  }
  const [colorPng, normalPng] = await Promise.all([
    sharp(graded, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer(),
    sharp(path.join(TEXTURE_DIR, 'walnut-normal.jpg')).png().toBuffer(),
  ]);
  const maps = {
    colorPng,
    normalPng,
    roughPng: null,
    roughnessFactor: key === 'grey' ? 0.5 : 0.42,
    size: info.width,
  };
  walnutCache.set(key, maps);
  return maps;
}

function parseObj(text) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const faces = [];
  let group = 'default';
  let material = '';
  let mtllib = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    if (tag === 'v') {
      positions.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]);
    } else if (tag === 'vn') {
      normals.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]);
    } else if (tag === 'vt') {
      uvs.push([Number(parts[1]), Number(parts[2])]);
    } else if (tag === 'g' || tag === 'o') {
      group = line.slice(tag.length).trim() || 'default';
    } else if (tag === 'usemtl') {
      material = line.slice(6).trim();
    } else if (tag === 'mtllib') {
      mtllib = line.slice(6).trim();
    } else if (tag === 'f') {
      const corners = parts.slice(1).map((token) => {
        const [v, vt, vn] = token.split('/');
        return {
          v: Number(v) - 1,
          vt: vt ? Number(vt) - 1 : -1,
          n: vn ? Number(vn) - 1 : -1,
        };
      });
      if (corners.length === 3) {
        faces.push({ group, material, corners });
      } else if (corners.length > 3) {
        for (let i = 1; i < corners.length - 1; i += 1) {
          faces.push({ group, material, corners: [corners[0], corners[i], corners[i + 1]] });
        }
      }
    }
  }
  return { positions, normals, uvs, faces, mtllib };
}

async function parseMtl(mtlPath) {
  let text = '';
  try {
    text = await fs.readFile(mtlPath, 'utf8');
  } catch {
    return new Map();
  }
  const materials = new Map();
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('newmtl')) {
      current = { name: line.slice(6).trim(), kd: [0.5, 0.4, 0.3], mapKd: '' };
      materials.set(current.name, current);
    } else if (!current) {
      continue;
    } else if (line.startsWith('Kd')) {
      const [, r, g, b] = line.split(/\s+/);
      current.kd = [Number(r), Number(g), Number(b)];
    } else if (line.startsWith('map_Kd')) {
      current.mapKd = line.slice(6).trim().replace(/^"+|"+$/g, '');
    }
  }
  return materials;
}

export function partFrame(min, max, upAxis = 2) {
  const size = [0, 1, 2].map((axis) => max[axis] - min[axis]);
  const order = [0, 1, 2].sort((a, b) => size[b] - size[a] || a - b);
  let grain = order[0];
  const thin = order[2];
  const slab = size[order[0]] < size[order[1]] * 2.2;
  const horizontal = Math.max(size[0], size[1], 1e-6);
  if (slab && thin === upAxis && upAxis === 2 && Math.abs(size[0] - size[1]) / horizontal < 0.2) {
    grain = 1;
  }
  const other = [0, 1, 2].filter((axis) => axis !== grain).sort((a, b) => size[b] - size[a]);
  const stick = size[grain] > size[other[0]] * 2.2;
  const roundish = size[other[0]] <= size[other[1]] * 1.65;
  const mode = stick && roundish ? 'lathe' : 'box';
  const radius = Math.max((size[other[0]] + size[other[1]]) / 4, 0.05);
  const center = [0, 1, 2].map((axis) => (min[axis] + max[axis]) / 2);
  return { grain, mode, center, radius, size };
}

function faceNormal(a, b, c) {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz) || 1;
  return [nx / length, ny / length, nz / length];
}

function dominantAxis(normal) {
  const ax = Math.abs(normal[0]);
  const ay = Math.abs(normal[1]);
  const az = Math.abs(normal[2]);
  if (ax >= ay && ax >= az) return 0;
  if (ay >= az) return 1;
  return 2;
}

export function uvsForTriangle(points, normal, frame, tile = TILE_CM) {
  const grain = frame.grain;
  const others = [0, 1, 2].filter((axis) => axis !== grain);
  const endGrain = Math.abs(normal[grain]) > 0.65;
  if (frame.mode === 'lathe' && !endGrain) {
    const span = (2 * Math.PI * frame.radius) / tile;
    const uvs = points.map((point) => {
      const a = point[others[0]] - frame.center[others[0]];
      const b = point[others[1]] - frame.center[others[1]];
      const turns = Math.atan2(b, a) / (2 * Math.PI) + 0.5;
      return [turns * span, point[grain] / tile];
    });
    const us = uvs.map((uv) => uv[0]);
    const minU = Math.min(...us);
    const maxU = Math.max(...us);
    if (maxU - minU > span * 0.5) {
      for (const uv of uvs) {
        if (uv[0] < minU + span * 0.5) uv[0] += span;
      }
    }
    return uvs;
  }
  if (endGrain) {
    return points.map((point) => [point[others[0]] / tile, point[others[1]] / tile]);
  }
  const facing = dominantAxis(normal);
  const uAxis = [0, 1, 2].find((axis) => axis !== grain && axis !== facing) ?? others[0];
  return points.map((point) => [point[uAxis] / tile, point[grain] / tile]);
}

function groupFrames(parsed) {
  const bounds = new Map();
  for (const face of parsed.faces) {
    let box = bounds.get(face.group);
    if (!box) {
      box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      bounds.set(face.group, box);
    }
    for (const corner of face.corners) {
      const point = parsed.positions[corner.v];
      for (let axis = 0; axis < 3; axis += 1) {
        box.min[axis] = Math.min(box.min[axis], point[axis]);
        box.max[axis] = Math.max(box.max[axis], point[axis]);
      }
    }
  }
  const frames = new Map();
  for (const [name, box] of bounds) frames.set(name, partFrame(box.min, box.max, 2));
  return frames;
}

function buildPrimitive(document, buffer, parsed, faces, material, frames, tile) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const weld = new Map();

  const addCorner = (point, normal, uv) => {
    const key = [
      point.map((value) => value.toFixed(4)).join(','),
      normal.map((value) => value.toFixed(3)).join(','),
      uv.map((value) => value.toFixed(4)).join(','),
    ].join('|');
    const existing = weld.get(key);
    if (existing !== undefined) return existing;
    const index = positions.length / 3;
    positions.push(point[0], point[1], point[2]);
    normals.push(normal[0], normal[1], normal[2]);
    uvs.push(uv[0], uv[1]);
    weld.set(key, index);
    return index;
  };

  for (const face of faces) {
    const points = face.corners.map((corner) => parsed.positions[corner.v]);
    const geometric = faceNormal(points[0], points[1], points[2]);
    const cornerNormals = face.corners.map((corner) => {
      const stored = corner.n >= 0 ? parsed.normals[corner.n] : null;
      return stored ?? geometric;
    });
    const frame = frames.get(face.group);
    const faceUvs = uvsForTriangle(points, geometric, frame, tile);
    for (let corner = 0; corner < 3; corner += 1) {
      indices.push(addCorner(points[corner], cornerNormals[corner], faceUvs[corner]));
    }
  }

  const indexArray = positions.length / 3 > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  const primitive = document.createPrimitive()
    .setAttribute('POSITION', document.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer))
    .setAttribute('NORMAL', document.createAccessor().setType('VEC3').setArray(new Float32Array(normals)).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', document.createAccessor().setType('VEC2').setArray(new Float32Array(uvs)).setBuffer(buffer))
    .setIndices(document.createAccessor().setType('SCALAR').setArray(indexArray).setBuffer(buffer))
    .setMaterial(material);
  return document.createMesh().addPrimitive(primitive);
}

function attachTexture(document, material, slot, name, png, kind) {
  const texture = document.createTexture(name).setImage(png).setMimeType('image/png');
  if (slot === 'baseColor') material.setBaseColorTexture(texture);
  else if (slot === 'normal') material.setNormalTexture(texture);
  else material.setMetallicRoughnessTexture(texture);
  const info = slot === 'baseColor'
    ? material.getBaseColorTextureInfo()
    : slot === 'normal'
      ? material.getNormalTextureInfo()
      : material.getMetallicRoughnessTextureInfo();
  info
    .setWrapS(TextureInfo.WrapMode.REPEAT)
    .setWrapT(TextureInfo.WrapMode.REPEAT)
    .setMagFilter(TextureInfo.MagFilter.LINEAR)
    .setMinFilter(TextureInfo.MinFilter.LINEAR_MIPMAP_LINEAR);
  return kind;
}

async function addWoodMaterial(document, materialName, species, maps) {
  const normalScale = species === 'leather' ? 0.28 : species === 'maple' ? 0.55 : 0.85;
  const material = document.createMaterial(materialName || species)
    .setMetallicFactor(0)
    .setRoughnessFactor(maps.roughnessFactor ?? 1)
    .setBaseColorFactor([1, 1, 1, 1])
    .setNormalScale(normalScale);
  attachTexture(document, material, 'baseColor', `${species}-color`, maps.colorPng);
  attachTexture(document, material, 'normal', `${species}-normal`, maps.normalPng);
  if (maps.roughPng) attachTexture(document, material, 'roughness', `${species}-roughness`, maps.roughPng);
  return material;
}

/**
 * @param {string} objPath
 * @param {{ wood?: 'auto'|'walnut'|'maple', stain?: 'warm'|'grey', textureSize?: number }} [options]
 */
export async function loadFusionObj(objPath, options = {}) {
  const text = await fs.readFile(objPath, 'utf8');
  const parsed = parseObj(text);
  if (parsed.faces.length === 0) {
    throw new Error('This OBJ has no triangles.');
  }
  const mtlPath = parsed.mtllib ? path.resolve(path.dirname(objPath), parsed.mtllib) : '';
  const library = mtlPath ? await parseMtl(mtlPath) : new Map();
  const frames = groupFrames(parsed);
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene('Scene');
  document.getRoot().setDefaultScene(scene);

  const byMaterial = new Map();
  for (const face of parsed.faces) {
    const key = face.material || 'default';
    const list = byMaterial.get(key);
    if (list) list.push(face);
    else byMaterial.set(key, [face]);
  }

  const summaries = [];
  for (const [materialName, faces] of byMaterial) {
    const mtl = library.get(materialName);
    let species = materialFinish(materialName, mtl?.kd);
    if (species !== 'leather') species = resolveSpecies(options.wood ?? 'auto', materialName, mtl?.kd);
    const size = options.textureSize ?? (species === 'leather' ? 512 : 1024);
    const stain = options.stain === 'grey' ? 'grey' : 'warm';
    const maps = species === 'leather'
      ? await generateLeatherMaps({ size })
      : species === 'walnut'
        ? await walnutMapsForStain(stain)
        : await generateWoodMaps({ species, size });
    const tile = species === 'leather' ? LEATHER_TILE_CM : species === 'walnut' ? WOOD_TILE_CM : TILE_CM;
    const material = await addWoodMaterial(document, materialName, species, maps);
    if (mtl?.mapKd && mtlPath) {
      const imagePath = path.resolve(path.dirname(mtlPath), mtl.mapKd);
      const image = await sharp(imagePath).ensureAlpha().png().toBuffer();
      const texture = document.createTexture(path.basename(imagePath)).setImage(image).setMimeType('image/png');
      material.setBaseColorTexture(texture);
    }
    const mesh = buildPrimitive(document, buffer, parsed, faces, material, frames, tile);
    scene.addChild(document.createNode(materialName || 'Chair').setMesh(mesh));
    summaries.push({
      material: materialName,
      species,
      triangles: faces.length,
      kd: mtl?.kd ?? null,
      flatColor: !mtl?.mapKd,
      stain: species === 'walnut' ? stain : null,
    });
  }

  return { document, summaries, mtllib: parsed.mtllib };
}
