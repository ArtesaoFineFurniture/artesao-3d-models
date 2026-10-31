/**
 * Write a small ASCII FBX 7.4 box. three.js FBXLoader reads this.
 * Dimensions are in file units. UnitScaleFactor is the FBX convention:
 * centimeters per file unit (1 = cm, 100 = m, 0.1 = mm, 2.54 = inch).
 * UpAxis 1 is Y-up. UpAxis 2 is Z-up, and the loader stands that up.
 */
import { writeFile } from 'node:fs/promises';

function endIndex(index) {
  return -index - 1;
}

function face(indices) {
  const copy = indices.slice();
  copy[copy.length - 1] = endIndex(copy[copy.length - 1]);
  return copy;
}

export function buildBoxFbx({
  width,
  depth,
  height,
  unitScaleFactor = 1,
  upAxis = 1,
}) {
  const w = width / 2;
  const d = depth / 2;
  // Y-up: height runs along Y. Z-up: height runs along Z and Y is the depth.
  const vertices = upAxis === 2
    ? [
      -w, -d, 0,
      w, -d, 0,
      w, d, 0,
      -w, d, 0,
      -w, -d, height,
      w, -d, height,
      w, d, height,
      -w, d, height,
    ]
    : [
      -w, 0, -d,
      w, 0, -d,
      w, 0, d,
      -w, 0, d,
      -w, height, -d,
      w, height, -d,
      w, height, d,
      -w, height, d,
    ];
  const indices = [
    ...face([0, 1, 2, 3]),
    ...face([4, 7, 6, 5]),
    ...face([0, 4, 5, 1]),
    ...face([3, 2, 6, 7]),
    ...face([0, 3, 7, 4]),
    ...face([1, 5, 6, 2]),
  ];
  const rows = [
    [0, '; FBX 7.4.0 project file'],
    [0, 'FBXHeaderExtension:  {'],
    [1, 'FBXHeaderVersion: 1003'],
    [1, 'FBXVersion: 7400'],
    [0, '}'],
    [0, 'GlobalSettings:  {'],
    [1, 'Version: 1000'],
    [1, 'Properties70:  {'],
    [2, `P: "UpAxis", "int", "Integer", "",${upAxis}`],
    [2, 'P: "UpAxisSign", "int", "Integer", "",1'],
    [2, `P: "UnitScaleFactor", "double", "Number", "",${unitScaleFactor}`],
    [1, '}'],
    [0, '}'],
    [0, 'Objects:  {'],
    [1, 'Geometry: 300, "Geometry::Piece", "Mesh" {'],
    [2, `Vertices: *${vertices.length} {`],
    [3, `a: ${vertices.join(',')}`],
    [2, '}'],
    [2, `PolygonVertexIndex: *${indices.length} {`],
    [3, `a: ${indices.join(',')}`],
    [2, '}'],
    [2, 'GeometryVersion: 124'],
    [1, '}'],
    [1, 'Model: 100, "Model::Piece", "Mesh" {'],
    [2, 'Version: 232'],
    [2, 'Properties70:  {'],
    [3, 'P: "Lcl Translation", "Lcl Translation", "", "A",0,0,0'],
    [3, 'P: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,0'],
    [3, 'P: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1'],
    [2, '}'],
    [1, '}'],
    [0, '}'],
    [0, 'Connections:  {'],
    [1, 'C: "OO",300,100'],
    [1, 'C: "OO",100,0'],
    [0, '}'],
  ];
  const text = `${rows.map(([indent, line]) => `${'\t'.repeat(indent)}${line}`).join('\n')}\n`;
  return new TextEncoder().encode(text);
}

export function sampleStoolFbx() {
  return buildBoxFbx({
    width: 50,
    depth: 44,
    height: 90,
    unitScaleFactor: 1,
    upAxis: 1,
  });
}

const isMain = process.argv[1] && process.argv[1].endsWith('sample-fbx.mjs');
if (isMain) {
  const out = process.argv[2] || new URL('../fixtures/sample-stool.fbx', import.meta.url);
  await writeFile(out, sampleStoolFbx());
  console.log(`Wrote ${out}`);
}
