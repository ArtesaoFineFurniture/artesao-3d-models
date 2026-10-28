#!/usr/bin/env node
/**
 * Build an iOS Quick Look USDZ from a web GLB.
 *
 * The GLB is read only. Geometry stays in meters and Y-up, which is what
 * ar-scale="fixed" and Quick Look both treat as real size. glTF texture
 * coordinates start at the top left; USD starts at the bottom left, so V is
 * flipped. WebP images are rewritten as PNG, because Quick Look does not
 * display WebP. Packaging and the OpenUSD checks live in pack_usdz.py
 * (pip install usd-core).
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { getBounds } from '@gltf-transform/core';
import sharp from 'sharp';

import { createIO } from './optimize.mjs';

const MESH_MAGIC = 0x314d4553;
const BOUNDS_TOLERANCE_M = 0.0005;
const JSDELIVR_FILE_LIMIT = 20 * 1024 * 1024;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const WRAP = {
  10497: 'repeat',
  33071: 'clamp',
  33648: 'mirror',
};

export function gltfUvToUsdSt(u, v) {
  return [u, 1 - v];
}

export function isIdentityMatrix(matrix) {
  return IDENTITY.every((value, index) => Math.abs(matrix[index] - value) < 1e-6);
}

export function transformPoint(matrix, x, y, z) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function transformNormal(matrix, x, y, z) {
  const m00 = matrix[0];
  const m01 = matrix[4];
  const m02 = matrix[8];
  const m10 = matrix[1];
  const m11 = matrix[5];
  const m12 = matrix[9];
  const m20 = matrix[2];
  const m21 = matrix[6];
  const m22 = matrix[10];
  const c00 = m11 * m22 - m12 * m21;
  const c01 = m02 * m21 - m01 * m22;
  const c02 = m01 * m12 - m02 * m11;
  const c10 = m12 * m20 - m10 * m22;
  const c11 = m00 * m22 - m02 * m20;
  const c12 = m02 * m10 - m00 * m12;
  const c20 = m10 * m21 - m11 * m20;
  const c21 = m01 * m20 - m00 * m21;
  const c22 = m00 * m11 - m01 * m10;
  const det = m00 * c00 + m01 * c10 + m02 * c20;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    throw new Error('The node transform cannot be applied to normals.');
  }
  const inv = 1 / det;
  const t00 = c00 * inv;
  const t01 = c01 * inv;
  const t02 = c02 * inv;
  const t10 = c10 * inv;
  const t11 = c11 * inv;
  const t12 = c12 * inv;
  const t20 = c20 * inv;
  const t21 = c21 * inv;
  const t22 = c22 * inv;
  let nx = t00 * x + t01 * y + t02 * z;
  let ny = t10 * x + t11 * y + t12 * z;
  let nz = t20 * x + t21 * y + t22 * z;
  const length = Math.hypot(nx, ny, nz) || 1;
  return [nx / length, ny / length, nz / length];
}

function primName(raw, fallback) {
  const cleaned = String(raw || '')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  if (!cleaned || /^[0-9]/.test(cleaned)) return `${fallback}_${cleaned || 'Prim'}`;
  return cleaned;
}

function uniqueName(raw, fallback, used) {
  const base = primName(raw, fallback);
  let name = base;
  let index = 2;
  while (used.has(name)) name = `${base}_${index++}`;
  used.add(name);
  return name;
}

function textureFileName(raw, used) {
  const base = String(raw || 'texture')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'texture';
  let name = `${base}.png`;
  let index = 2;
  while (used.has(name)) name = `${base}_${index++}.png`;
  used.add(name);
  return name;
}

function wrapMode(info, method) {
  if (!info || typeof info[method] !== 'function') return 'repeat';
  return WRAP[info[method]()] || 'repeat';
}

function textureCoordinate(info) {
  if (!info || typeof info.getTexCoord !== 'function') return 0;
  return info.getTexCoord();
}

function assertNoTextureTransform(info) {
  if (!info || typeof info.listExtensions !== 'function') return;
  for (const extension of info.listExtensions()) {
    if (extension.extensionName === 'KHR_texture_transform') {
      throw new Error('KHR_texture_transform is not supported in the USDZ export.');
    }
  }
}

function includeBounds(bounds, positions) {
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis];
      bounds.min[axis] = Math.min(bounds.min[axis], value);
      bounds.max[axis] = Math.max(bounds.max[axis], value);
    }
  }
}

async function exportTexture(texture, role, colorSpace, info, textures, usedNames) {
  const existing = textures.get(texture);
  if (existing) {
    if (existing.role !== role || existing.colorSpace !== colorSpace) {
      throw new Error(`Texture "${texture.getName() || role}" is used as both ${existing.role} and ${role}.`);
    }
    const wrapS = wrapMode(info, 'getWrapS');
    const wrapT = wrapMode(info, 'getWrapT');
    if (existing.wrapS !== wrapS || existing.wrapT !== wrapT) {
      throw new Error(`Texture "${texture.getName() || role}" uses more than one wrap mode.`);
    }
    return existing;
  }

  const image = texture.getImage();
  if (!image) throw new Error(`Texture "${texture.getName() || role}" has no image.`);
  const decoded = await sharp(Buffer.from(image)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (decoded.info.channels !== 3) {
    throw new Error(`Texture "${texture.getName() || role}" did not decode to RGB.`);
  }
  const png = await sharp(decoded.data, {
    raw: { width: decoded.info.width, height: decoded.info.height, channels: 3 },
  }).png({ compressionLevel: 9 }).toBuffer();
  const roundTrip = await sharp(png).removeAlpha().raw().toBuffer();
  if (!roundTrip.equals(decoded.data)) {
    throw new Error(`Texture "${texture.getName() || role}" changed when it was saved as PNG.`);
  }

  const fileName = textureFileName(texture.getName(), usedNames);
  const record = {
    file: `textures/${fileName}`,
    role,
    colorSpace,
    wrapS: wrapMode(info, 'getWrapS'),
    wrapT: wrapMode(info, 'getWrapT'),
    width: decoded.info.width,
    height: decoded.info.height,
    sha256: createHash('sha256').update(png).digest('hex'),
    png,
  };
  textures.set(texture, record);
  return record;
}

function slot(material, role, getter, infoGetter) {
  const texture = getter.call(material);
  if (!texture) return null;
  const info = infoGetter.call(material);
  assertNoTextureTransform(info);
  const texCoord = textureCoordinate(info);
  if (texCoord !== 0) {
    throw new Error(`${material.getName() || role} uses TEXCOORD_${texCoord}. Only TEXCOORD_0 is exported.`);
  }
  return { texture, info };
}

async function buildExtract(document, workdir) {
  const root = document.getRoot();
  const scene = root.getDefaultScene() || root.listScenes()[0];
  if (!scene) throw new Error('The GLB has no scene.');

  await mkdir(path.join(workdir, 'meshes'), { recursive: true });
  await mkdir(path.join(workdir, 'textures'), { recursive: true });

  const textures = new Map();
  const usedTextureNames = new Set();
  const usedMaterialNames = new Set();
  const usedMeshNames = new Set();
  const materials = [];
  const materialNames = new Map();
  const meshes = [];
  const bounds = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };

  async function materialRecord(material) {
    if (materialNames.has(material)) return materialNames.get(material);
    if (material.getAlphaMode() !== 'OPAQUE') {
      throw new Error(`${material.getName() || 'A material'} uses alpha mode ${material.getAlphaMode()}, which this export does not write.`);
    }
    if (Math.abs(material.getNormalScale() - 1) > 1e-4) {
      throw new Error(`${material.getName() || 'A material'} has normalScale ${material.getNormalScale()}. The USDZ export expects 1.`);
    }

    const name = uniqueName(material.getName(), 'Material', usedMaterialNames);
    const base = slot(material, 'baseColor', material.getBaseColorTexture, material.getBaseColorTextureInfo);
    const metallicRoughness = slot(
      material,
      'metallicRoughness',
      material.getMetallicRoughnessTexture,
      material.getMetallicRoughnessTextureInfo,
    );
    const normal = slot(material, 'normal', material.getNormalTexture, material.getNormalTextureInfo);
    if (material.getOcclusionTexture() || material.getEmissiveTexture()) {
      throw new Error(`${name} has an occlusion or emissive texture. Add it to the USDZ export before using that material.`);
    }

    const record = {
      name,
      baseColorFactor: material.getBaseColorFactor(),
      metallicFactor: material.getMetallicFactor(),
      roughnessFactor: material.getRoughnessFactor(),
      doubleSided: material.getDoubleSided(),
      baseColor: base
        ? await exportTexture(base.texture, 'baseColor', 'sRGB', base.info, textures, usedTextureNames)
        : null,
      metallicRoughness: metallicRoughness
        ? await exportTexture(
          metallicRoughness.texture,
          'metallicRoughness',
          'raw',
          metallicRoughness.info,
          textures,
          usedTextureNames,
        )
        : null,
      normal: normal
        ? await exportTexture(normal.texture, 'normal', 'raw', normal.info, textures, usedTextureNames)
        : null,
    };
    materials.push(record);
    materialNames.set(material, record);
    return record;
  }

  async function walk(node) {
    const mesh = node.getMesh();
    if (mesh) {
      const world = node.getWorldMatrix();
      const identity = isIdentityMatrix(world);
      let primitiveIndex = 0;
      for (const primitive of mesh.listPrimitives()) {
        if (primitive.getMode() !== 4) {
          throw new Error(`${node.getName() || mesh.getName() || 'A mesh'} is not made of triangles.`);
        }
        const positionAccessor = primitive.getAttribute('POSITION');
        const normalAccessor = primitive.getAttribute('NORMAL');
        const uvAccessor = primitive.getAttribute('TEXCOORD_0');
        if (!positionAccessor || !normalAccessor || !uvAccessor) {
          throw new Error(`${node.getName() || 'A mesh'} needs positions, normals, and TEXCOORD_0.`);
        }
        const vertexCount = positionAccessor.getCount();
        if (normalAccessor.getCount() !== vertexCount || uvAccessor.getCount() !== vertexCount) {
          throw new Error(`${node.getName() || 'A mesh'} does not share one index across positions, normals, and UVs.`);
        }

        const sourcePositions = positionAccessor.getArray();
        const sourceNormals = normalAccessor.getArray();
        const sourceUvs = uvAccessor.getArray();
        const positions = new Float32Array(sourcePositions.length);
        const normals = new Float32Array(sourceNormals.length);
        const uvs = new Float32Array(sourceUvs.length);
        for (let index = 0; index < vertexCount; index += 1) {
          const point = identity
            ? [sourcePositions[index * 3], sourcePositions[index * 3 + 1], sourcePositions[index * 3 + 2]]
            : transformPoint(world, sourcePositions[index * 3], sourcePositions[index * 3 + 1], sourcePositions[index * 3 + 2]);
          const normal = identity
            ? [sourceNormals[index * 3], sourceNormals[index * 3 + 1], sourceNormals[index * 3 + 2]]
            : transformNormal(world, sourceNormals[index * 3], sourceNormals[index * 3 + 1], sourceNormals[index * 3 + 2]);
          positions.set(point, index * 3);
          normals.set(normal, index * 3);
          const [u, v] = gltfUvToUsdSt(sourceUvs[index * 2], sourceUvs[index * 2 + 1]);
          uvs[index * 2] = u;
          uvs[index * 2 + 1] = v;
        }

        const indexAccessor = primitive.getIndices();
        const indices = indexAccessor
          ? Uint32Array.from(indexAccessor.getArray())
          : Uint32Array.from({ length: vertexCount }, (_, index) => index);
        if (indices.length % 3 !== 0) throw new Error('Triangle indices are incomplete.');

        const material = primitive.getMaterial();
        if (!material) throw new Error(`${node.getName() || 'A mesh'} has a primitive with no material.`);
        const materialInfo = await materialRecord(material);
        const meshName = uniqueName(
          primitiveIndex === 0 ? (node.getName() || mesh.getName()) : `${node.getName() || mesh.getName()}_${primitiveIndex}`,
          'Mesh',
          usedMeshNames,
        );
        const binName = `meshes/${meshes.length}.bin`;
        await writeMeshBin(path.join(workdir, binName), positions, normals, uvs, indices);
        includeBounds(bounds, positions);
        meshes.push({
          name: meshName,
          bin: binName,
          material: materialInfo.name,
          doubleSided: materialInfo.doubleSided,
        });
        primitiveIndex += 1;
      }
    }
    for (const child of node.listChildren()) await walk(child);
  }

  for (const child of scene.listChildren()) await walk(child);
  if (meshes.length === 0) throw new Error('The GLB has no meshes.');

  const sceneBounds = getBounds(scene);
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(sceneBounds.min[axis] - bounds.min[axis]) > BOUNDS_TOLERANCE_M
      || Math.abs(sceneBounds.max[axis] - bounds.max[axis]) > BOUNDS_TOLERANCE_M) {
      throw new Error('The exported bounds do not match the GLB bounds. The node transforms were not applied the same way.');
    }
  }

  const textureRecords = [];
  for (const record of textures.values()) {
    await writeFile(path.join(workdir, record.file), record.png);
    textureRecords.push({
      file: record.file,
      role: record.role,
      colorSpace: record.colorSpace,
      wrapS: record.wrapS,
      wrapT: record.wrapT,
      width: record.width,
      height: record.height,
      sha256: record.sha256,
    });
  }

  const meta = {
    bounds: {
      min: bounds.min,
      max: bounds.max,
    },
    meshes,
    materials: materials.map((material) => ({
      name: material.name,
      baseColorFactor: material.baseColorFactor,
      metallicFactor: material.metallicFactor,
      roughnessFactor: material.roughnessFactor,
      doubleSided: material.doubleSided,
      baseColor: material.baseColor ? publicTexture(material.baseColor) : null,
      metallicRoughness: material.metallicRoughness ? publicTexture(material.metallicRoughness) : null,
      normal: material.normal ? publicTexture(material.normal) : null,
    })),
    textures: textureRecords,
  };
  await writeFile(path.join(workdir, 'meta.json'), JSON.stringify(meta));
  return meta;
}

function publicTexture(record) {
  return {
    file: record.file,
    colorSpace: record.colorSpace,
    wrapS: record.wrapS,
    wrapT: record.wrapT,
  };
}

function writeMeshBin(file, positions, normals, uvs, indices) {
  const header = Buffer.alloc(16);
  header.writeUInt32LE(MESH_MAGIC, 0);
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(positions.length / 3, 8);
  header.writeUInt32LE(indices.length, 12);
  return writeFile(file, Buffer.concat([
    header,
    Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength),
    Buffer.from(normals.buffer, normals.byteOffset, normals.byteLength),
    Buffer.from(uvs.buffer, uvs.byteOffset, uvs.byteLength),
    Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength),
  ]));
}

function centimetres(min, max) {
  return [0, 2, 1].map((axis) => ((max[axis] - min[axis]) * 100).toFixed(2));
}

export async function convertGlbToUsdz(input, output) {
  const resolvedInput = path.resolve(input);
  const resolvedOutput = path.resolve(output);
  if (!resolvedInput.toLowerCase().endsWith('.glb')) {
    throw new Error('The input has to be a .glb file.');
  }
  if (!resolvedOutput.toLowerCase().endsWith('.usdz')) {
    throw new Error('The output has to be a .usdz file.');
  }
  if (resolvedInput === resolvedOutput) {
    throw new Error('Refusing to overwrite the GLB.');
  }

  const before = await readFile(resolvedInput);
  const io = await createIO();
  const document = await io.read(resolvedInput);
  const workdir = await mkdtemp(path.join(tmpdir(), 'artesao-usdz-'));
  try {
    await buildExtract(document, workdir);
    await mkdir(path.dirname(resolvedOutput), { recursive: true });
    const packScript = fileURLToPath(new URL('./pack_usdz.py', import.meta.url));
    const python = spawnSync('python3', [packScript, workdir, resolvedOutput], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (python.error) {
      throw new Error('Python 3 is required to pack the USDZ. Install it, then pip install usd-core.');
    }
    if (python.stderr) process.stderr.write(python.stderr);
    if (python.status !== 0) {
      const detail = [python.stdout?.trim(), python.stderr?.trim()].filter(Boolean).join('\n');
      throw new Error(detail || `pack_usdz.py exited ${python.status}`);
    }
    const reportLine = python.stdout.trim().split('\n').at(-1);
    const report = JSON.parse(reportLine);
    if (!report.ok) {
      throw new Error(report.errors?.join('\n') || 'USDZ validation failed.');
    }
    if (report.bytes > JSDELIVR_FILE_LIMIT) {
      throw new Error(`USDZ is ${(report.bytes / 1024 / 1024).toFixed(1)} MB. jsDelivr serves files up to 20 MB.`);
    }
    const after = await readFile(resolvedInput);
    if (!after.equals(before)) throw new Error('The GLB changed while the USDZ was written.');
    const [wide, deep, tall] = centimetres(report.boundsMin, report.boundsMax);
    console.log(`${path.basename(resolvedOutput)}  ${(report.bytes / 1024).toFixed(0)} KB  ${wide} × ${deep} × ${tall} cm  Y-up  1 m/unit  ${report.textureCount} textures`);
    return report;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

async function main(args) {
  const input = args[0];
  if (!input) {
    console.error('Usage: node scripts/glb-to-usdz.mjs <input.glb> <output.usdz>');
    process.exitCode = 1;
    return;
  }
  const output = args[1] || input.replace(/\.glb$/i, '.usdz');
  await convertGlbToUsdz(input, output);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
