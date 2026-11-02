export function formatAspectRatio(width?: number, height?: number): string {
  if (!width || !height || width <= 0 || height <= 0) return "—";
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(Math.round(width), Math.round(height));
  const rw = Math.round(width / divisor);
  const rh = Math.round(height / divisor);
  const ratio = width / height;

  if (Math.abs(ratio - 1) < 0.015) return "1:1 (Square)";
  if (Math.abs(ratio - 16 / 9) < 0.02) return "16:9 (Landscape)";
  if (Math.abs(ratio - 9 / 16) < 0.02) return "9:16 (Portrait / Reel)";
  if (Math.abs(ratio - 4 / 3) < 0.02) return "4:3 (Standard)";
  if (Math.abs(ratio - 3 / 4) < 0.02) return "3:4 (Portrait)";
  if (Math.abs(ratio - 3 / 2) < 0.02) return "3:2 (Classic 35mm)";
  if (Math.abs(ratio - 2 / 3) < 0.02) return "2:3 (Portrait 35mm)";
  if (Math.abs(ratio - 21 / 9) < 0.03) return "21:9 (Ultrawide)";
  if (Math.abs(ratio - 16 / 10) < 0.02) return "16:10";
  if (rw <= 32 && rh <= 32) return `${rw}:${rh}`;
  return `${ratio >= 1 ? ratio.toFixed(2) : `1:${(1 / ratio).toFixed(2)}`}`;
}
