export type Rgb = Readonly<{ r: number; g: number; b: number }>;
export type ColorMatch = Readonly<{
  exposure: number;
  temperature: number;
  tint: number;
  saturation: number;
  contrast: number;
}>;

export function suggestMatch(subject: Rgb, background: Rgb): ColorMatch {
  const sy = luma(subject),
    by = luma(background);
  const exposure = Math.log2(Math.max(0.04, by / 255) / Math.max(0.04, sy / 255));
  const temperature = (background.r - background.b) / 255 - (subject.r - subject.b) / 255;
  const tint =
    (background.g - (background.r + background.b) / 2) / 255 -
    (subject.g - (subject.r + subject.b) / 2) / 255;
  const saturation = chroma(background) - chroma(subject);
  const contrast = 0;
  return {
    exposure: clamp(exposure, -1, 1),
    temperature: clamp(temperature, -0.5, 0.5),
    tint: clamp(tint, -0.4, 0.4),
    saturation: clamp(saturation, -0.4, 0.4),
    contrast,
  };
}

export function applyColorMatch(data: Uint8ClampedArray, match: ColorMatch, strength: number) {
  const mix = Math.min(1, Math.max(0, strength / 100));
  if (mix <= 0) return;
  const exposure = Math.pow(2, match.exposure * mix);
  const temp = match.temperature * mix;
  const tint = match.tint * mix;
  const sat = match.saturation * mix;
  const contrast = match.contrast * mix;
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i + 3] ?? 0) === 0) continue;
    let r = (data[i] ?? 0) * exposure;
    let g = (data[i + 1] ?? 0) * exposure;
    let b = (data[i + 2] ?? 0) * exposure;
    r *= 1 + temp;
    b *= 1 - temp;
    g *= 1 + tint;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = y + (r - y) * (1 + sat);
    g = y + (g - y) * (1 + sat);
    b = y + (b - y) * (1 + sat);
    r = (r - 128) * (1 + contrast) + 128;
    g = (g - 128) * (1 + contrast) + 128;
    b = (b - 128) * (1 + contrast) + 128;
    data[i] = clamp(r, 0, 255);
    data[i + 1] = clamp(g, 0, 255);
    data[i + 2] = clamp(b, 0, 255);
  }
}

export function meanOpaque(data: Uint8ClampedArray): Rgb {
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const weight = (data[i + 3] ?? 0) / 255;
    if (weight === 0) continue;
    r += (data[i] ?? 0) * weight;
    g += (data[i + 1] ?? 0) * weight;
    b += (data[i + 2] ?? 0) * weight;
    n += weight;
  }
  if (!n) return { r: 128, g: 128, b: 128 };
  return { r: r / n, g: g / n, b: b / n };
}

function luma(color: Rgb) {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

function chroma(color: Rgb) {
  return (Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b)) / 255;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
