// Review image for src/palette.js: renders the palette's colours as a PNG
// swatch, writes a receipt binding the PNG to the exact palette bytes, and
// prints the receipt locator as its last stdout line.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const source = readFileSync("src/palette.js");
const colours = [...source.toString().matchAll(/#([0-9a-fA-F]{6})/g)].map((m) => m[1]);
if (!colours.length) throw new Error("src/palette.js names no #rrggbb colours");
const cell = 16, w = cell * colours.length, h = cell;
const rows = [];
for (let y = 0; y < h; y++) {
  const row = [0];
  for (let x = 0; x < w; x++) {
    const c = colours[Math.floor(x / cell)];
    row.push(parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16));
  }
  rows.push(Buffer.from(row));
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(Buffer.concat(rows))),
  chunk("IEND", Buffer.alloc(0)),
]);
mkdirSync("review-out", { recursive: true });
writeFileSync("review-out/swatch.png", png);
const receipt = Buffer.from(JSON.stringify({ candidate: sha(source), image: sha(png), colours }) + "\n");
writeFileSync("review-out/receipt.json", receipt);
console.log(`palette swatch: ${colours.length} colours, ${w}x${h}`);
console.log(JSON.stringify({ receipt: "review-out/receipt.json", sha256: sha(receipt) }));
