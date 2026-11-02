// npm run dev or a production preview must be running at APP_URL.
// The ?src= launch API must ask before it fetches from another site or saves a file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { launchChrome } from "./chrome.mjs";
import { appCandidates } from "./app-url.mjs";
import { requireCutout } from "./require-server.mjs";

const appUrl = await requireCutout(appCandidates("http://127.0.0.1:8080/"));
const sample = readFileSync(new URL("../public/sample.jpg", import.meta.url));
const remote = "https://images.example/cat.jpg";
let browser;
before(async () => {
  browser = await launchChrome();
});
after(async () => {
  await browser?.close();
});

/** A page whose "other site" is served locally, recording what it fetched. */
async function open(search) {
  const page = await browser.newPage({ acceptDownloads: true });
  page.setDefaultTimeout(15000);
  // Headless Chrome has no save dialog: the picker aborts as if the user cancelled.
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
  });
  const fetched = { remote: 0, models: 0 };
  await page.route("https://images.example/**", (route) => {
    fetched.remote++;
    return route.fulfill({
      body: sample,
      headers: {
        "content-type": "image/jpeg",
        "access-control-allow-origin": "*",
        "cross-origin-resource-policy": "cross-origin",
      },
    });
  });
  page.on("request", (request) => {
    if (/huggingface|\.onnx(?:\?|$)/.test(request.url())) fetched.models++;
  });
  await page.goto(new URL(search, appUrl).href, { waitUntil: "domcontentloaded" });
  return { page, fetched };
}

test("a link to another site's image asks first and fetches nothing until confirmed", async () => {
  const { page, fetched } = await open(`/?src=${encodeURIComponent(remote)}&download=1`);
  let downloads = 0;
  page.on("download", () => downloads++);
  try {
    const dialog = page.getByRole("dialog", { name: "Load an image from images.example?" });
    await dialog.waitFor();
    assert.equal(await dialog.locator("strong").textContent(), "images.example");
    assert.equal(
      new URL(page.url()).search,
      "",
      "launch parameters are removed from the address bar",
    );
    await page.waitForTimeout(1500);
    assert.deepEqual(fetched, { remote: 0, models: 0 });
    assert.equal(downloads, 0);

    const download = page.waitForEvent("download", { timeout: 240_000 });
    await dialog.getByRole("button", { name: "Load and download" }).click();
    await page.getByRole("toolbar", { name: "Image actions" }).waitFor({ timeout: 240_000 });
    assert.equal(fetched.remote, 1);
    assert.match((await download).suggestedFilename(), /^cat/);
  } finally {
    await page.close();
  }
});

test("Cancel leaves the workspace untouched", async () => {
  const { page, fetched } = await open(`/?src=${encodeURIComponent(remote)}`);
  try {
    const dialog = page.getByRole("dialog", { name: "Load an image from images.example?" });
    await dialog.getByRole("button", { name: "Load image" }).waitFor();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    await page.waitForTimeout(1000);
    assert.deepEqual(fetched, { remote: 0, models: 0 });
    await page.getByRole("button", { name: "Choose files", exact: true }).waitFor();
  } finally {
    await page.close();
  }
});

test("F2: a failed launch fetch shows classified copy with a file-upload next step", async () => {
  const page = await browser.newPage();
  try {
    await page.route(
      (url) => url.pathname === "/linked-image.jpg",
      (route) => route.abort("internetdisconnected"),
    );
    await page.goto(new URL("/?src=/linked-image.jpg", appUrl).href);
    const alert = page.getByRole("alert");
    await alert.waitFor();
    const message = await alert.textContent();
    assert.match(message, /Couldn’t load the linked image\. Check the link and your connection\./);
    assert.match(message, /Choose a file from your device to continue\./);
    assert.doesNotMatch(message, /Failed to fetch|cross-origin access|TypeError/);
    await page.getByRole("button", { name: "Choose files", exact: true }).waitFor();
  } finally {
    await page.close();
  }
});

test("this site's own image loads without a prompt; plain http from elsewhere is ignored", async () => {
  const own = await open("/?src=/sample.jpg");
  try {
    await own.page.getByText("sample.jpg").first().waitFor();
    assert.equal(await own.page.getByRole("dialog").count(), 0);
  } finally {
    await own.page.close();
  }
  const insecure = await open("/?src=http://images.example/cat.jpg&download=1");
  try {
    // download=1 alone still asks; the http source itself is dropped.
    const dialog = insecure.page.getByRole("dialog", {
      name: "Download the result when it’s ready?",
    });
    await dialog.waitFor();
    await insecure.page.waitForTimeout(1000);
    assert.equal(insecure.fetched.remote, 0);
  } finally {
    await insecure.page.close();
  }
});
