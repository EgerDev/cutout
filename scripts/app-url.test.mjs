import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { after, before, test } from "node:test";
import { appCandidates, e2eUrl, findCutout } from "./app-url.mjs";

/** A stand-in server: `routes` maps a path to a JSON body; anything else is a 404. */
async function serve(routes) {
  const server = http.createServer((req, res) => {
    const body = routes[new URL(req.url, "http://x").pathname];
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(body ? JSON.stringify(body) : "");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

const manifest = { "/manifest.webmanifest": { name: "Cutout" } };
let cutout, otherBuild, noVersion, otherApp, closedUrl;

before(async () => {
  cutout = await serve({ ...manifest, "/version.json": { version: "0.1.0", commit: "abc123" } });
  otherBuild = await serve({
    ...manifest,
    "/version.json": { version: "0.1.0", commit: "def456" },
  });
  noVersion = await serve(manifest);
  otherApp = await serve({ "/manifest.webmanifest": { name: "Something else" } });
  const closed = await serve({});
  closedUrl = closed.url;
  closed.server.close();
});
after(() => {
  for (const s of [cutout, otherBuild, noVersion, otherApp]) s.server.close();
});

test("any Cutout matches when no commit is expected", async () => {
  assert.equal(await findCutout([noVersion.url], { expectCommit: "" }), noVersion.url);
});

test("skips servers that are down or are not Cutout", async () => {
  assert.equal(
    await findCutout([closedUrl, otherApp.url, cutout.url], { expectCommit: "" }),
    cutout.url,
  );
  assert.equal(await findCutout([closedUrl, otherApp.url], { expectCommit: "" }), null);
});

test("with an expected commit, a different build on the port is rejected", async () => {
  assert.equal(await findCutout([otherBuild.url], { expectCommit: "abc123" }), null);
  assert.equal(await findCutout([noVersion.url], { expectCommit: "abc123" }), null);
  assert.equal(
    await findCutout([otherBuild.url, cutout.url], { expectCommit: "abc123" }),
    cutout.url,
  );
});

test("CUTOUT_EXPECT_COMMIT is the default expectation", async (t) => {
  const saved = process.env.CUTOUT_EXPECT_COMMIT;
  t.after(() => {
    if (saved === undefined) delete process.env.CUTOUT_EXPECT_COMMIT;
    else process.env.CUTOUT_EXPECT_COMMIT = saved;
  });
  process.env.CUTOUT_EXPECT_COMMIT = "abc123";
  assert.equal(await findCutout([otherBuild.url]), null);
  assert.equal(await findCutout([cutout.url]), cutout.url);
});

test("APP_URL replaces the fallbacks instead of trying them after it", (t) => {
  const saved = process.env.APP_URL;
  t.after(() => {
    if (saved === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = saved;
  });
  process.env.APP_URL = "http://127.0.0.1:8161/";
  assert.deepEqual(appCandidates("http://127.0.0.1:8081/", "http://127.0.0.1:8080/"), [
    "http://127.0.0.1:8161/",
  ]);
  delete process.env.APP_URL;
  assert.deepEqual(appCandidates("http://127.0.0.1:8081/"), ["http://127.0.0.1:8081/"]);
});

test("e2eUrl adds the e2e flag to any route", () => {
  assert.equal(e2eUrl("http://127.0.0.1:8161/"), "http://127.0.0.1:8161/?e2e");
  assert.equal(e2eUrl("http://127.0.0.1:8161/", "/guide"), "http://127.0.0.1:8161/guide?e2e");
  assert.equal(e2eUrl("http://h/", "/?src=x"), "http://h/?src=x&e2e");
});
