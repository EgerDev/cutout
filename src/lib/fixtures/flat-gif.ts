// Test-only flat LZW GIF generator from the independent C38 review reproducer.
function flatGif(width: number, height: number) {
  const head = Buffer.from("47494638396100000000800000000000ffffff", "hex");
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  const descriptor = Buffer.alloc(10);
  descriptor[0] = 0x2c;
  descriptor.writeUInt16LE(width, 5);
  descriptor.writeUInt16LE(height, 7);
  const data: number[] = [];
  let bitbuf = 0,
    filled = 0,
    bits = 3,
    next = 6,
    old = false;
  const emit = (code: number) => {
    bitbuf |= code << filled;
    filled += bits;
    while (filled >= 8) {
      data.push(bitbuf & 255);
      bitbuf >>>= 8;
      filled -= 8;
    }
    if (code === 4) {
      bits = 3;
      next = 6;
      old = false;
    } else if (code !== 5) {
      if (old) {
        next++;
        if (next === 1 << bits && bits < 12) bits++;
      }
      old = true;
    }
  };
  let remaining = width * height;
  emit(4);
  while (remaining > 0) {
    emit(0);
    remaining--;
    for (let length = 2; remaining > 0 && length <= 4091; length++) {
      const use = Math.min(length, remaining);
      emit(use === 1 ? 0 : use + 4);
      remaining -= use;
    }
    if (remaining > 0) emit(4);
  }
  emit(5);
  if (filled) data.push(bitbuf & 255);
  const parts = [head, descriptor, Buffer.from([2])];
  for (let at = 0; at < data.length; at += 255) {
    const d = Buffer.from(data.slice(at, at + 255));
    parts.push(Buffer.from([d.length]), d);
  }
  parts.push(Buffer.from([0, 0x3b]));
  return Buffer.concat(parts);
}

export function paddedGif(width = 10000, height = 10000) {
  const gif = flatGif(width, height);
  // Native decoders grow the 1x1 logical screen to the overflowing first frame.
  gif.writeUInt16LE(1, 6);
  gif.writeUInt16LE(1, 8);
  const extension = [Buffer.from([0x21, 0xfe])];
  for (let n = 0; n < 1100; n++) extension.push(Buffer.from([255]), Buffer.alloc(255, 0x20));
  extension.push(Buffer.from([0]));
  return Buffer.concat([gif.subarray(0, 19), ...extension, gif.subarray(19)]);
}
