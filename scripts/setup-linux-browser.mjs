// Test-container only: provide Playwright's Chrome channel with software WebGPU.
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
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

export function installSoftwareChrome(wrapper, binary) {
  // Check and replace the same inode; never follow an existing symlink or truncate Chrome.
  let fd;
  let created = false;
  try {
    fd = openSync(wrapper, "wx+", 0o755);
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    fd = openSync(
      wrapper,
      constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096)
      throw new Error("Refusing to replace an existing Chrome installation");
    if (!created && stat.size > 0) {
      const contents = Buffer.alloc(stat.size);
      readSync(fd, contents, 0, contents.length, 0);
      if (!contents.toString("utf8").includes(marker))
        throw new Error("Refusing to replace an existing Chrome installation");
    }
    const script = softwareChromeScript(binary);
    writeFileSync(fd, script);
    ftruncateSync(fd, Buffer.byteLength(script));
  } finally {
    closeSync(fd);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== "linux") throw new Error("Linux test containers only");
  const require = createRequire(`${process.cwd()}/package.json`);
  const { chromium } = require("playwright");
  const binary = chromium.executablePath();
  const wrapper = "/opt/google/chrome/chrome";
  mkdirSync("/opt/google/chrome", { recursive: true });
  installSoftwareChrome(wrapper, binary);
  console.log(`Software WebGPU Chrome wrapper: ${wrapper} -> ${binary}`);
}
