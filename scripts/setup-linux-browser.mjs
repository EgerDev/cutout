// Test-container only: provide Playwright's Chrome channel with software WebGPU.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const marker = "# Cutout Linux CI software WebGPU";

export function softwareChromeScript(binary) {
  const quoted = `'${binary.replaceAll("'", "'\\''")}'`;
  return `#!/bin/sh
${marker}
# Keep software GPU limited to graphics checks; real inference uses the Linux CPU path.
if [ "\${CUTOUT_SOFTWARE_WEBGPU:-1}" = "0" ]; then exec ${quoted} "$@"; fi
# Forced WASM must retain the unmodified browser process controls.
for arg in "$@"; do
  if [ "$arg" = "--disable-gpu" ]; then exec ${quoted} "$@"; fi
done
exec ${quoted} "$@" --enable-unsafe-webgpu --ignore-gpu-blocklist --use-angle=swiftshader --use-vulkan=swiftshader --enable-features=Vulkan
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== "linux") throw new Error("Linux test containers only");
  const require = createRequire(`${process.cwd()}/package.json`);
  const { chromium } = require("playwright");
  const binary = chromium.executablePath();
  const wrapper = "/opt/google/chrome/chrome";
  if (
    existsSync(wrapper) &&
    (statSync(wrapper).size > 4096 || !readFileSync(wrapper, "utf8").includes(marker))
  )
    throw new Error("Refusing to replace an existing Chrome installation");
  mkdirSync("/opt/google/chrome", { recursive: true });
  writeFileSync(wrapper, softwareChromeScript(binary), { mode: 0o755 });
  console.log(`Software WebGPU Chrome wrapper: ${wrapper} -> ${binary}`);
}
