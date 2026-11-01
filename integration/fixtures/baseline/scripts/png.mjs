// PNG writer and reader for 8-bit RGBA images, and a polygon fill to draw them.
// Pixels are a flat [r, g, b, a, ...] Uint8Array, row by row from the top left.
import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Build a PNG file (a Buffer) from width * height RGBA pixels. */
export function writePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error("rgba must hold width * height * 4 bytes");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA, deflate, adaptive filtering, no interlace
  const rows = Buffer.alloc(height * (1 + width * 4)); // each row starts with filter type 0 (none)
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(rows, y * (1 + width * 4) + 1);
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** Parse a PNG written by writePng: { width, height, rgba }. Throws when it is malformed. */
export function readPng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG: bad signature");
  let at = 8;
  let ihdr;
  const idat = [];
  for (;;) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + length);
    if (buf.readUInt32BE(at + 8 + length) !== crc32(buf.subarray(at + 4, at + 8 + length))) throw new Error(`bad CRC in ${type}`);
    at += 12 + length;
    if (type === "IHDR") ihdr = data;
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") break;
  }
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  if (ihdr[8] !== 8 || ihdr[9] !== 6) throw new Error("only 8-bit RGBA is supported");
  const rows = inflateSync(Buffer.concat(idat));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    if (rows[y * (1 + width * 4)] !== 0) throw new Error("only filter type 0 is supported");
    rgba.set(rows.subarray(y * (1 + width * 4) + 1, (y + 1) * (1 + width * 4)), y * width * 4);
  }
  return { width, height, rgba };
}

/** Fill the polygon [[x, y], ...] in rgba (width pixels per row) with color [r, g, b, a]. */
export function fillPolygon(rgba, width, points, color) {
  const height = rgba.length / 4 / width;
  for (let y = 0; y < height; y++) {
    const xs = [];
    points.forEach(([x0, y0], i) => {
      const [x1, y1] = points[(i + 1) % points.length];
      if (y0 <= y + 0.5 !== y1 <= y + 0.5) xs.push(x0 + ((y + 0.5 - y0) / (y1 - y0)) * (x1 - x0));
    });
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2)
      for (let x = Math.max(0, Math.round(xs[i])); x < Math.min(width, Math.round(xs[i + 1])); x++) rgba.set(color, (y * width + x) * 4);
  }
}
