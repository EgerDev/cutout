import { chromium } from "playwright";

/**
 * Makes every context and page this browser creates bypass the page's Content Security
 * Policy by default. Playwright polls waitForFunction by evaluating strings, which an
 * enforced script-src without 'unsafe-eval' rightly forbids. Only the CSP suite, which
 * must see the real policy, opts out (launchChrome({ bypassCSP: false })).
 */
export function bypassCsp(browser) {
  const newContext = browser.newContext.bind(browser);
  const newPage = browser.newPage.bind(browser);
  browser.newContext = (options = {}) => newContext({ bypassCSP: true, ...options });
  browser.newPage = (options = {}) => newPage({ bypassCSP: true, ...options });
  return browser;
}

/**
 * Linux runs Playwright's WPE WebKit, whose renderer can crash mid-test on the full app
 * stylesheet or under codec load (a recorded environment limit, docs/release-status.md).
 * True for that crash on Linux, so a test can skip its WebKit leg; assertions still fail.
 */
export function webkitCrashed(error) {
  return process.platform === "linux" && /has been closed/.test(error?.message ?? "");
}

/** A WebKit test body (subtests included) that skips instead of failing on that crash. */
export function tolerateWebkitCrash(body) {
  return async (t) => {
    const subtest = t.test.bind(t);
    t.test = (name, ...args) =>
      subtest(
        name,
        ...args.map((arg) => (typeof arg === "function" ? tolerateWebkitCrash(arg) : arg)),
      );
    try {
      return await body(t);
    } catch (error) {
      if (!webkitCrashed(error)) throw error;
      t.skip("Linux WPE WebKit crashed (recorded environment limit)");
    }
  };
}

/**
 * Google Chrome when it is installed; Playwright's bundled Chromium otherwise.
 * Most Linux machines and CI images ship Chromium, not /opt/google/chrome.
 */
export async function launchChrome({ bypassCSP = true, ...options } = {}) {
  let browser;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true, ...options });
  } catch (error) {
    if (!String(error?.message).includes("distribution 'chrome' is not found")) throw error;
    browser = await chromium.launch({ headless: true, ...options });
  }
  return bypassCSP ? bypassCsp(browser) : browser;
}

/** Persistent/default context: CDP audit pages share its HTTP cache. */
export async function launchChromeContext(profileDirectory, options = {}) {
  try {
    return await chromium.launchPersistentContext(profileDirectory, {
      channel: "chrome",
      headless: true,
      ...options,
    });
  } catch (error) {
    if (!String(error?.message).includes("distribution 'chrome' is not found")) throw error;
    return chromium.launchPersistentContext(profileDirectory, { headless: true, ...options });
  }
}
