// Binary glTF (GLB) 2.0 writer and reader for models with one triangle mesh.
// Positions are a flat [x, y, z, ...] array; indices (optional) are vertex numbers;
// color (optional) is the material's [r, g, b, a] base colour, each 0 to 1.
const MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a; // "JSON"
const BIN_CHUNK = 0x004e4942; // "BIN\0"

const pad4 = (n) => (n + 3) & ~3;

/** Build a GLB file (a Buffer) holding one mesh with the given positions. */
export function writeGlb(positions, indices, color) {
  if (positions.length === 0 || positions.length % 3 !== 0) throw new Error("positions must hold x, y, z triples");
  const pos = Buffer.alloc(positions.length * 4);
  positions.forEach((v, i) => pos.writeFloatLE(v, i * 4));
  const idx = Buffer.alloc(pad4((indices?.length ?? 0) * 2));
  indices?.forEach((v, i) => idx.writeUInt16LE(v, i * 2));
  const bin = Buffer.concat([pos, idx]);
  const min = [0, 1, 2].map((a) => Math.min(...positions.filter((_, i) => i % 3 === a)));
  const max = [0, 1, 2].map((a) => Math.max(...positions.filter((_, i) => i % 3 === a)));
  const gltf = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0 }, ...(indices ? { indices: 1 } : {}), ...(color ? { material: 0 } : {}) }] },
    ],
    ...(color ? { materials: [{ pbrMetallicRoughness: { baseColorFactor: color } }] } : {}),
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: "VEC3", min, max },
      ...(indices ? [{ bufferView: 1, componentType: 5123, count: indices.length, type: "SCALAR" }] : []),
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.length },
      ...(indices ? [{ buffer: 0, byteOffset: pos.length, byteLength: indices.length * 2 }] : []),
    ],
    buffers: [{ byteLength: bin.length }],
  };
  const json = Buffer.from(JSON.stringify(gltf));
  const jsonPadded = Buffer.concat([json, Buffer.alloc(pad4(json.length) - json.length, 0x20)]);
  const out = Buffer.alloc(12 + 8 + jsonPadded.length + 8 + bin.length);
  out.writeUInt32LE(MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonPadded.length, 12);
  out.writeUInt32LE(JSON_CHUNK, 16);
  jsonPadded.copy(out, 20);
  const binAt = 20 + jsonPadded.length;
  out.writeUInt32LE(bin.length, binAt);
  out.writeUInt32LE(BIN_CHUNK, binAt + 4);
  bin.copy(out, binAt + 8);
  return out;
}

/** Parse a GLB file written by writeGlb: { gltf, positions, indices, color }. Throws when it is malformed. */
export function readGlb(buf) {
  if (buf.readUInt32LE(0) !== MAGIC) throw new Error("not a GLB: bad magic");
  if (buf.readUInt32LE(4) !== 2) throw new Error("not glTF 2.0");
  if (buf.readUInt32LE(8) !== buf.length) throw new Error("GLB length does not match the file");
  const jsonLength = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== JSON_CHUNK || jsonLength % 4 !== 0) throw new Error("bad JSON chunk");
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLength).toString());
  const binAt = 20 + jsonLength;
  const binLength = buf.readUInt32LE(binAt);
  if (buf.readUInt32LE(binAt + 4) !== BIN_CHUNK || binLength % 4 !== 0) throw new Error("bad BIN chunk");
  if (binAt + 8 + binLength !== buf.length) throw new Error("BIN chunk does not end the file");
  const bin = buf.subarray(binAt + 8);
  const view = (i) => gltf.bufferViews[gltf.accessors[i].bufferView];
  const posView = view(0);
  const positions = Array.from({ length: gltf.accessors[0].count * 3 }, (_, i) => bin.readFloatLE(posView.byteOffset + i * 4));
  const indexAccessor = gltf.meshes[0].primitives[0].indices;
  const indices =
    indexAccessor === undefined
      ? undefined
      : Array.from({ length: gltf.accessors[indexAccessor].count }, (_, i) => bin.readUInt16LE(view(indexAccessor).byteOffset + i * 2));
  return { gltf, positions, indices, color: gltf.materials?.[0]?.pbrMetallicRoughness?.baseColorFactor };
}
