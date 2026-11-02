import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  LAUNCH_MAX_BYTES,
  fetchLaunchSource,
  nameFromUrl,
  needsConfirmation,
  parseLaunchParams,
} from "./url-api.ts";

test("parseLaunchParams validates every field and ignores junk", () => {
  const plan = parseLaunchParams(
    "?src=https://example.com/a/photo%20one.jpg&preset=amazon&format=jpg&bg=%23ff8800&download=1&name=out.jpg",
  );
  assert.ok(plan);
  assert.equal(plan.src, "https://example.com/a/photo%20one.jpg");
  assert.equal(plan.preset, "amazon");
  assert.equal(plan.format, "jpeg");
  assert.deepEqual(plan.background, { type: "color", color: "#ff8800" });
  assert.equal(plan.download, true);
  assert.equal(plan.name, "out.jpg");

  // nothing valid → no launch at all
  assert.equal(parseLaunchParams("?src=javascript:alert(1)&preset=nope&format=exe&bg=zzz"), null);
  const partial = parseLaunchParams("?src=ftp://x/y&preset=nope&format=webp&name=../x");
  assert.ok(partial);
  assert.equal(partial.src, null);
  assert.equal(partial.preset, null);
  assert.equal(partial.format, "webp");
  assert.equal(partial.name, "..x");
  assert.equal(parseLaunchParams("?utm_source=x"), null);
  assert.deepEqual(parseLaunchParams("?bg=blur")?.background, { type: "blur" });
  assert.deepEqual(parseLaunchParams("?bg=white")?.background, { type: "color", color: "#ffffff" });
});

test("nameFromUrl keeps the file name and adds an extension when missing", () => {
  assert.equal(nameFromUrl("https://x.test/p/My%20Photo.JPG?x=1", "image/jpeg"), "My Photo.JPG");
  assert.equal(nameFromUrl("https://x.test/p/abc123", "image/png"), "abc123.png");
  assert.equal(nameFromUrl("https://x.test/", "image/webp"), "image.webp");
});

test("parseLaunchParams only accepts https, or http on this same http origin", () => {
  assert.equal(parseLaunchParams("?src=http://x/y.jpg&download=1")?.src, null);
  const g = globalThis as { location?: unknown };
  const before = g.location;
  try {
    g.location = new URL("http://127.0.0.1:8130/");
    assert.equal(parseLaunchParams("?src=/sample.jpg")?.src, "http://127.0.0.1:8130/sample.jpg");
    assert.equal(parseLaunchParams("?src=http://evil.test/a.jpg&download=1")?.src, null);
    assert.equal(
      parseLaunchParams("?src=https://example.com/a.jpg")?.src,
      "https://example.com/a.jpg",
    );
    g.location = new URL("https://cutout.test/");
    assert.equal(parseLaunchParams("?src=http://cutout.test/a.jpg&download=1")?.src, null);
    assert.equal(parseLaunchParams("?src=/a.jpg")?.src, "https://cutout.test/a.jpg");
  } finally {
    g.location = before;
  }
});

test("nameFromUrl survives a malformed percent sequence", () => {
  assert.equal(nameFromUrl("https://a/b/%E0%A4%A.jpg", "image/jpeg"), "image.jpg");
});

test("needsConfirmation asks for other sites and for downloads, not for our own images", () => {
  const origin = "https://cutout.test";
  const plan = (search: string) => {
    const p = parseLaunchParams(search);
    assert.ok(p);
    return p;
  };
  assert.equal(needsConfirmation(plan("?src=https://example.com/x.jpg"), origin), true);
  assert.equal(needsConfirmation(plan("?src=https://cutout.test/x.jpg&download=1"), origin), true);
  assert.equal(needsConfirmation(plan("?download=1"), origin), true);
  assert.equal(
    needsConfirmation(plan("?src=https://cutout.test/x.jpg&preset=amazon"), origin),
    false,
  );
  assert.equal(needsConfirmation(plan("?preset=amazon"), origin), false);
});

function stubFetch(response: Response) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => response) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** A body 10 MB over the cap, in 1 MB chunks; counts how many were pulled. */
function oversizedBody() {
  const counter = { pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (counter.pulled++ > LAUNCH_MAX_BYTES / 1_000_000 + 10) controller.close();
      else controller.enqueue(new Uint8Array(1_000_000));
    },
  });
  return { body, counter };
}

test("fetchLaunchSource returns a named image file", async () => {
  const restore = stubFetch(
    new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
      headers: { "content-type": "image/jpeg" },
    }),
  );
  try {
    const file = await fetchLaunchSource("https://example.com/p/cat.jpg", null);
    assert.equal(file.name, "cat.jpg");
    assert.equal(file.type, "image/jpeg");
    assert.equal(file.size, 4);
  } finally {
    restore();
  }
});

test("fetchLaunchSource rejects SVG, by type or by content", async () => {
  const cases = [
    ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "image/svg+xml"],
    ['  <?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>', "image/png"],
  ];
  for (const [body, type] of cases) {
    const restore = stubFetch(new Response(body, { headers: { "content-type": type } }));
    try {
      await assert.rejects(fetchLaunchSource("https://example.com/x.png", null), /SVG/);
    } finally {
      restore();
    }
  }
});

const MARKUP = "<html><body><h1>Sign in again</h1><script>alert(1)</script></body></html>";
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48];

/** A response whose body arrives in the given pieces, as a slow host would send it. */
function chunked(parts: Array<string | number[]>, type: string) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts)
        controller.enqueue(
          typeof part === "string" ? new TextEncoder().encode(part) : new Uint8Array(part),
        );
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": type } });
}

async function launchRejects(response: Response, pattern: RegExp, label: string) {
  const restore = stubFetch(response);
  try {
    await assert.rejects(fetchLaunchSource("https://example.com/x.png", null), pattern, label);
  } finally {
    restore();
  }
}

test("fetchLaunchSource accepts only exact image types", async () => {
  // Each passed startsWith("image/"). The first survived as the File's type, which Chromium
  // serves as text/html; the others became "" and were sniffed.
  for (const type of [
    "image/png, text/html",
    "image/\tpng",
    "image/png\xff",
    "image/",
    "image/x",
  ]) {
    await launchRejects(chunked([PNG_BYTES], type), /not an image/, JSON.stringify(type));
    await launchRejects(chunked([" ".repeat(80) + MARKUP], type), /not an image/, type);
  }
});

test("fetchLaunchSource finds markup behind padding of any length, across chunks", async () => {
  // The old check decoded 64 bytes of the first chunk only.
  for (const parts of [
    [" ".repeat(80) + MARKUP],
    [" ".repeat(64), MARKUP],
    [" ", "\f", "\0", "\v", MARKUP],
    [[0xef, 0xbb], [0xbf, 0x0c], MARKUP],
    ["\f" + MARKUP],
    ["\v" + MARKUP],
  ]) {
    await launchRejects(chunked(parts, "image/png"), /SVG/, JSON.stringify(parts));
  }
});

test("fetchLaunchSource types the file from its bytes, not from the server", async () => {
  // A PNG served as JPEG, split so the signature spans two chunks.
  const restore = stubFetch(chunked([PNG_BYTES.slice(0, 3), PNG_BYTES.slice(3)], "image/jpeg"));
  try {
    const file = await fetchLaunchSource("https://example.com/p/shot", null);
    assert.equal(file.type, "image/png");
    assert.equal(file.name, "shot.png");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array(PNG_BYTES));
  } finally {
    restore();
  }
  // Bytes with no image signature are refused, whatever the header says.
  for (const body of ["hello <b>x</b>", "%PDF-1.7\n", "\0\0\0\0"])
    await launchRejects(chunked([body], "image/png"), /not an image/, JSON.stringify(body));
});

test("fetchLaunchSource refuses an image declared over the size cap without reading it", async () => {
  const { body, counter } = oversizedBody();
  const restore = stubFetch(
    new Response(body, {
      headers: { "content-type": "image/jpeg", "content-length": String(LAUNCH_MAX_BYTES + 1) },
    }),
  );
  try {
    await assert.rejects(fetchLaunchSource("https://example.com/big.jpg", null), /50 MB/);
    assert.ok(counter.pulled <= 1, `read ${counter.pulled} chunks`);
  } finally {
    restore();
  }
});

test("fetchLaunchSource stops reading a body without a length just past the size cap", async () => {
  const { body, counter } = oversizedBody();
  const restore = stubFetch(new Response(body, { headers: { "content-type": "image/jpeg" } }));
  try {
    await assert.rejects(fetchLaunchSource("https://example.com/endless.jpg", null), /50 MB/);
    assert.ok(
      counter.pulled <= LAUNCH_MAX_BYTES / 1_000_000 + 3,
      `pulled ${counter.pulled} chunks`,
    );
  } finally {
    restore();
  }
});

test("fetchLaunchSource gives up on a host that goes silent mid-download", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    // Headers and one chunk, then nothing until the request is aborted.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff, 0xd8]));
        init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
      },
    });
    return new Response(body, { headers: { "content-type": "image/jpeg" } });
  }) as typeof fetch;
  try {
    const pending = fetchLaunchSource("https://example.com/slow.jpg", null);
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(30_000);
    await assert.rejects(pending, /took too long to load/);
  } finally {
    globalThis.fetch = original;
  }
});

test("launch headers accept supported aliases and sequences with signature-derived types", async () => {
  const heic = readFileSync(new URL("./fixtures/tiny.heic", import.meta.url));
  for (const [header, bytes, expected] of [
    ["image/x-png", PNG_BYTES, "image/png"],
    ["IMAGE/X-PNG; charset=binary", PNG_BYTES, "image/png"],
    ["image/heic-sequence", heic, "image/heic"],
    ["image/heif-sequence; charset=binary", heic, "image/heic"],
  ] as const) {
    const restore = stubFetch(chunked([Array.from(bytes)], header));
    try {
      const file = await fetchLaunchSource("https://example.com/photo", null);
      assert.equal(file.type, expected, header);
      assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array(bytes));
    } finally {
      restore();
    }
    await launchRejects(chunked([MARKUP], header), /SVG/, header);
    await launchRejects(
      chunked([Array.from(bytes)], header.split(";")[0] + ", text/html"),
      /not an image/,
      header,
    );
  }
});
