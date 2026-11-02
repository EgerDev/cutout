/**
 * Binary dilation with a square window, in time linear in the pixel count
 * whatever the radius: per-row and per-column prefix sums. Used to find the
 * band of pixels next to a mask (a cleared field, a flood) without scanning a
 * window per pixel.
 */
export function dilateSquare(mark: Uint8Array, width: number, height: number, radius: number) {
  const rows = new Uint8Array(width * height);
  const prefix = new Uint32Array(Math.max(width, height) + 1);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) prefix[x + 1] = prefix[x]! + mark[row + x]!;
    for (let x = 0; x < width; x += 1) {
      const from = Math.max(0, x - radius);
      const to = Math.min(width, x + radius + 1);
      if (prefix[to]! > prefix[from]!) rows[row + x] = 1;
    }
  }
  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) prefix[y + 1] = prefix[y]! + rows[y * width + x]!;
    for (let y = 0; y < height; y += 1) {
      const from = Math.max(0, y - radius);
      const to = Math.min(height, y + radius + 1);
      if (prefix[to]! > prefix[from]!) out[y * width + x] = 1;
    }
  }
  return out;
}
