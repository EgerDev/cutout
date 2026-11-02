import { createDeflate } from "node:zlib";

/** First-page grayscale IFD, shared by safe header-only threshold probes and real strips. */
export function tiffHeader(width: number, height: number, stripBytes = 0, little = true) {
  const offset = 8 + 2 + 11 * 12 + 4;
  const tags = [
    [256, 4, width],
    [257, 4, height],
    [258, 3, 8],
    [259, 3, 8],
    [262, 3, 1],
    [273, 4, offset],
    [277, 3, 1],
    [278, 4, height],
    [279, 4, stripBytes],
    [284, 3, 1],
    [317, 3, 1],
  ];
  const bytes = new Uint8Array(offset);
  const view = new DataView(bytes.buffer);
  bytes.set(little ? [73, 73] : [77, 77]);
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little);
  view.setUint16(8, tags.length, little);
  tags.forEach(([tag, type, value], i) => {
    const at = 10 + i * 12;
    view.setUint16(at, tag!, little);
    view.setUint16(at + 2, type!, little);
    view.setUint32(at + 4, 1, little);
    if (type === 3) view.setUint16(at + 8, value!, little);
    else view.setUint32(at + 8, value!, little);
  });
  return bytes;
}

/** Review's single-strip Deflate fixture. Only a row and compressed bytes are allocated. */
export async function flatTiff(width = 16384, height = 16384) {
  const zip = createDeflate({ level: 9 });
  const parts: Buffer[] = [];
  zip.on("data", (part: Buffer) => parts.push(part));
  const done = new Promise<void>((resolve, reject) => {
    zip.on("end", resolve);
    zip.on("error", reject);
  });
  const row = Buffer.alloc(width, 200);
  for (let y = 0; y < height; y++) {
    if (!zip.write(row)) await new Promise<void>((resolve) => zip.once("drain", resolve));
  }
  zip.end();
  await done;
  const compressed = Buffer.concat(parts);
  return Buffer.concat([tiffHeader(width, height, compressed.length), compressed]);
}
