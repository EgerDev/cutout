// Playwright's bundled Nightly is ad-hoc signed. On macOS 27, that binary cannot
// initialize the profile service against ~/Library/Application Support/Firefox
// (Mozilla bug 2069536), so `firefox.launch()` dies with "Could not find profile
// folder" even when Playwright's -profile directory exists. Redirecting
// MOZ_APP_DATA / MOZ_LOCAL_APP_DATA to a disposable directory lets headless
// startup use the given profile. Profile errors still throw; missing binaries
// still throw "Executable doesn't exist".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { firefox } from "playwright";

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Playwright Firefox with app-data dirs Nightly can actually create. */
export async function launchFirefox(options = {}) {
  const acquired = [];
  const cleanup = () => {
    for (const dir of acquired.splice(0)) removeDir(dir);
  };
  try {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), "cutout-firefox-appdata-"));
    acquired.push(appData);
    const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), "cutout-firefox-localappdata-"));
    acquired.push(localAppData);
    const browser = await firefox.launch({
      ...options,
      env: {
        ...process.env,
        ...options.env,
        MOZ_APP_DATA: appData,
        MOZ_LOCAL_APP_DATA: localAppData,
      },
    });
    const close = browser.close.bind(browser);
    browser.close = async (...args) => {
      try {
        return await close(...args);
      } finally {
        cleanup();
      }
    };
    return browser;
  } catch (error) {
    cleanup();
    throw error;
  }
}
