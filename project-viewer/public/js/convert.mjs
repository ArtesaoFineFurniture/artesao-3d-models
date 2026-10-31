import {
  Box3,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Scene,
  Vector3,
} from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js';

// GLTFExporter finishes a binary file with FileReader. Browsers have it.
// Node, where the tests run, does not.
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReader {
    constructor() {
      this.result = null;
      this.onloadend = null;
    }

    readAsArrayBuffer(blob) {
      Promise.resolve(blob.arrayBuffer()).then((buffer) => {
        this.result = buffer;
        if (typeof this.onloadend === 'function') this.onloadend();
      });
    }
  };
}

export const UNIT_IN_METERS = {
  m: 1,
  cm: 0.01,
  mm: 0.001,
  in: 0.0254,
  ft: 0.3048,
};

const FBX_SYSTEM_UNITS = [
  [0.1, 'mm'],
  [1, 'cm'],
  [2.54, 'in'],
  [30.48, 'ft'],
  [100, 'm'],
];

const WALNUT = new Color(0x8b5a3c);

/**
 * Same rule as scripts/optimize.mjs: longest side ≤20 is meters,
 * ≤2000 is centimeters, and anything larger is millimeters.
 */
export function detectUnits(longestSide) {
  if (!Number.isFinite(longestSide) || longestSide <= 20) return 'm';
  if (longestSide <= 2000) return 'cm';
  return 'mm';
}

/** FBX UnitScaleFactor is "how many centimeters is one file unit". */
export function unitsFromFbxScale(factor) {
  const value = Number(factor);
  if (!Number.isFinite(value) || value <= 0) return null;
  for (const [scale, units] of FBX_SYSTEM_UNITS) {
    if (Math.abs(value - scale) <= scale * 1e-3) return units;
  }
  return null;
}

export function resolveUnits({ longest, unitScaleFactor, units = 'auto' }) {
  if (units !== 'auto') {
    if (!UNIT_IN_METERS[units]) {
      throw new Error('Unknown units. Use auto, m, cm, mm, in, or ft.');
    }
    return { units, source: 'chosen' };
  }
  const fromFile = unitsFromFbxScale(unitScaleFactor);
  if (fromFile) return { units: fromFile, source: 'file' };
  return { units: detectUnits(longest), source: 'size' };
}

function asArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  const view = ArrayBuffer.isView(data) ? data : new Uint8Array(data);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function standardMaterial(source) {
  const color = WALNUT.clone();
  if (source?.color?.isColor) {
    const sum = source.color.r + source.color.g + source.color.b;
    if (sum > 0.05) color.copy(source.color);
  }
  return new MeshStandardMaterial({
    color,
    roughness: 0.72,
    metalness: 0,
    side: 0, // FrontSide. USDZ has no double-sided materials.
  });
}

function bakeToFloor(root) {
  root.updateMatrixWorld(true);
  const group = new Group();
  group.name = 'Furniture';
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry?.getAttribute('position')) return;
    const geometry = obj.geometry.clone();
    geometry.applyMatrix4(obj.matrixWorld);
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const source = Array.isArray(obj.material) ? obj.material : [obj.material];
    const materials = source.map((material) => standardMaterial(material));
    const mesh = new Mesh(geometry, materials.length > 1 ? materials : materials[0]);
    mesh.name = obj.name || 'Mesh';
    group.add(mesh);
  });
  if (group.children.length === 0) {
    throw new Error('This FBX has no mesh. Export the piece itself, not an empty scene.');
  }
  group.updateMatrixWorld(true);
  const box = new Box3().setFromObject(group);
  const size = box.getSize(new Vector3());
  if (box.isEmpty() || !Number.isFinite(size.x) || Math.max(size.x, size.y, size.z) === 0) {
    throw new Error('This FBX has no measurable geometry.');
  }
  const center = box.getCenter(new Vector3());
  const shift = new Matrix4().makeTranslation(-center.x, -box.min.y, -center.z);
  for (const mesh of group.children) mesh.geometry.applyMatrix4(shift);
  group.updateMatrixWorld(true);
  return group;
}

function measuredSize(object) {
  const box = new Box3().setFromObject(object);
  const size = box.getSize(new Vector3());
  return {
    box,
    size,
    sizeMeters: { x: size.x, y: size.y, z: size.z },
  };
}

/**
 * Load an FBX, scale it into metres, centre it, and sit it on the floor.
 * Textures are dropped. The GLB and the USDZ are the form, in real metres.
 */
export async function convertFbx(buffer, { units = 'auto', up = 'file' } = {}) {
  if (up !== 'file' && up !== 'z') throw new Error('Unknown orientation.');
  const loader = new FBXLoader();
  const root = loader.parse(asArrayBuffer(buffer), '');
  if (up === 'z') root.rotateX(-Math.PI / 2);
  root.updateMatrixWorld(true);

  const before = measuredSize(root);
  const longest = Math.max(before.size.x, before.size.y, before.size.z);
  if (!Number.isFinite(longest) || longest === 0) {
    throw new Error('This FBX has no measurable geometry.');
  }
  const unitScaleFactor = root.userData?.unitScaleFactor;
  const resolved = resolveUnits({ longest, unitScaleFactor, units });
  const scale = UNIT_IN_METERS[resolved.units];
  root.scale.multiplyScalar(scale);
  root.updateMatrixWorld(true);

  const baked = bakeToFloor(root);
  const after = measuredSize(baked);
  const scene = new Scene();
  scene.name = 'Furniture';
  scene.add(baked);

  const glb = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: true });
  const usdz = await new USDZExporter().parseAsync(scene, {
    quickLookCompatible: true,
    includeAnchoringProperties: true,
    ar: {
      anchoring: { type: 'plane' },
      planeAnchoring: { alignment: 'horizontal' },
    },
  });
  scene.remove(baked);

  return {
    units: resolved.units,
    unitSource: resolved.source,
    scale,
    longest,
    unitScaleFactor: Number.isFinite(Number(unitScaleFactor)) ? Number(unitScaleFactor) : null,
    sizeMeters: after.sizeMeters,
    floor: { minY: after.box.min.y, centerX: (after.box.min.x + after.box.max.x) / 2, centerZ: (after.box.min.z + after.box.max.z) / 2 },
    glb: asArrayBuffer(glb),
    usdz: asArrayBuffer(usdz),
    object: baked,
  };
}
