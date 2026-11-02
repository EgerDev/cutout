import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/** `--color-name: #rrggbb` declarations inside the first block after `marker`. */
function tokens(marker: string) {
  const start = css.indexOf(marker);
  assert.ok(start >= 0, `${marker} not found in styles.css`);
  const block = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...block.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2]]),
  );
}

/** WCAG 2.x contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const themes = {
  light: tokens("@theme {"),
  dark: tokens("@media (prefers-color-scheme: dark) {\n  :root {"),
};

test("body text colours reach 4.5:1 on every surface in both themes", () => {
  const failures: string[] = [];
  for (const [theme, t] of Object.entries(themes)) {
    for (const text of ["fg", "muted", "accent"]) {
      for (const surface of ["bg", "elevated", "subtle", "float"]) {
        assert.ok(
          t[text] && t[surface],
          `${theme} is missing --color-${text} or --color-${surface}`,
        );
        const ratio = contrast(t[text], t[surface]);
        if (ratio < 4.5) failures.push(`${theme} ${text} on ${surface}: ${ratio.toFixed(3)}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});
