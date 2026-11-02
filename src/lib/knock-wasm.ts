import simdUrl from "./key-simd.wasm?url";

type KeyExports = {
  key4: (bytes: number, r: number, g: number, b: number) => void;
  memory: WebAssembly.Memory;
};

let simd: KeyExports | null | undefined;

async function instantiate(url: string) {
  const bytes = await fetch(url).then((response) => response.arrayBuffer());
  return WebAssembly.instantiate(bytes);
}

export async function ensureKnockWasm() {
  if (simd !== undefined) return Boolean(simd);
  try {
    const result = await instantiate(simdUrl);
    simd = result.instance.exports as unknown as KeyExports;
  } catch {
    simd = null;
  }
  return Boolean(simd);
}

function grow(memory: WebAssembly.Memory, bytes: number) {
  const pages = Math.ceil(bytes / 65536);
  const have = memory.buffer.byteLength / 65536;
  if (pages > have) memory.grow(pages - have);
}

/**
 * Zeros every pixel within exact distance of the field: the pixels stripPaper zeros
 * first anyway, so this only speeds stripPaper up and never changes the cut. The SIMD
 * kernel keys whole 16-byte blocks; JS keys the last pixels, or all of them without SIMD.
 * The scalar key.wasm pass that used to run here also keyed a soft band. Run over the
 * whole buffer after SIMD, it read SIMD-cleared pixels as black and, on a near-black
 * field, brought the entire background back as a dark veil.
 */
export function knockPaperWasm(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  field: { r: number; g: number; b: number },
) {
  const r = Math.round(field.r);
  const g = Math.round(field.g);
  const b = Math.round(field.b);
  const bytes = width * height * 4;
  const aligned = simd ? bytes & ~15 : 0;
  if (simd && aligned) {
    grow(simd.memory, aligned);
    const view = new Uint8Array(simd.memory.buffer, 0, aligned);
    view.set(data.subarray(0, aligned));
    simd.key4(aligned, r, g, b);
    data.set(view);
  }
  for (let i = aligned; i < bytes; i += 4) {
    const dr = data[i]! - r;
    const dg = data[i + 1]! - g;
    const db = data[i + 2]! - b;
    if (dr * dr + dg * dg + db * db <= 196) data.fill(0, i, i + 4);
  }
}
