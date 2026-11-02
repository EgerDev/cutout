/** 32-bit BGRA BMP (BITMAPV5) so cutouts keep alpha. */

export function encodeBmp(data: Uint8ClampedArray, width: number, height: number): Blob {
  if (width < 1 || height < 1 || data.length < width * height * 4)
    throw new Error("This image cannot be encoded as BMP.");
  const row = width * 4;
  const pixels = row * height;
  const header = 14;
  const dib = 124;
  const offset = header + dib;
  const bytes = new Uint8Array(offset + pixels);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x42;
  bytes[1] = 0x4d;
  view.setUint32(2, bytes.length, true);
  view.setUint32(10, offset, true);
  view.setUint32(14, dib, true);
  view.setInt32(18, width, true);
  view.setInt32(22, -height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 32, true);
  view.setUint32(30, 3, true);
  view.setUint32(34, pixels, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);
  view.setUint32(54, 0x00ff0000, true);
  view.setUint32(58, 0x0000ff00, true);
  view.setUint32(62, 0x000000ff, true);
  view.setUint32(66, 0xff000000, true);
  view.setUint32(70, 0x73524742, true);
  for (let i = 0, o = offset; i < data.length; i += 4, o += 4) {
    bytes[o] = data[i + 2] ?? 0;
    bytes[o + 1] = data[i + 1] ?? 0;
    bytes[o + 2] = data[i] ?? 0;
    bytes[o + 3] = data[i + 3] ?? 0;
  }
  return new Blob([bytes], { type: "image/bmp" });
}
