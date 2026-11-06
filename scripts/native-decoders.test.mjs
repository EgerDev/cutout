import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const helper = new URL("./native-decoders.mjs", import.meta.url).href;
const fixture = `
  import test from "node:test";
  import { testNativeDecoders } from ${JSON.stringify(helper)};
  const options = JSON.parse(process.argv[1]);
  Object.defineProperty(process, "platform", { value: options.platform ?? "linux" });
  const samples = options.empty ? [] : [1, 17, 129].map(width => ({bytes: [], width, height: 65}));
  const calls = { Chrome: [], WebKit: [], closed: [] };
  test("cross-browser AVIF", async t => {
    await testNativeDecoders(t, samples, ["WebKit", "Chrome"].map(name => ({
      name,
      open: async () => ({
        decode: async (bytes, width, height) => {
          calls[name].push(width);
          if (name === options.target) {
            if (options.fault === "close") throw new Error("Target page, context or browser has been closed");
            if (options.fault === "codec") throw new Error("The source image could not be decoded");
          }
          const pixel = name === options.target && options.fault === "pixels" ? [0, 0, 0, 0] : [80, 180, 220, 255];
          return {width, height, last: pixel, bottom: pixel};
        },
        close: () => calls.closed.push(name),
      }),
    })));
  });
  process.on("exit", () => console.log("CALLS " + JSON.stringify(calls)));
`;

function run(options) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--test-reporter=tap", "--input-type=module", "-e", fixture, JSON.stringify(options)],
    {
      env,
      encoding: "utf8",
    },
  );
  assert.ifError(result.error);
  const output = result.stdout + result.stderr;
  const calls = JSON.parse(output.match(/CALLS (\{.*\})/)[1]);
  return { status: result.status, output, calls };
}

test("a Linux WebKit decoder closure skips only that leg and still asserts every Chrome size", () => {
  const result = run({ target: "WebKit", fault: "close" });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /WebKit decoder.*SKIP Linux WPE WebKit crashed/);
  assert.deepEqual(result.calls.Chrome, [1, 17, 129]);
  assert.deepEqual(result.calls.WebKit, [1]);
  assert.deepEqual(result.calls.closed, ["WebKit", "Chrome"]);
});

for (const target of ["Chrome", "WebKit"]) {
  for (const fault of ["pixels", "codec"]) {
    test(`${target} ${fault} failures still fail the decoder suite`, () => {
      const result = run({ target, fault });
      assert.notEqual(result.status, 0, result.output);
      assert.match(
        result.output,
        fault === "pixels" ? /last column/ : /source image could not be decoded/,
      );
      assert.doesNotMatch(result.output, /SKIP/);
      assert.deepEqual(result.calls.closed, ["WebKit", "Chrome"]);
    });
  }
}

test("Chrome closure remains a failure on Linux", () => {
  const result = run({ target: "Chrome", fault: "close" });
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /not ok.*Chrome decoder/);
  assert.doesNotMatch(result.output, /SKIP/);
});

test("WebKit closure remains a failure on macOS", () => {
  const result = run({ target: "WebKit", fault: "close", platform: "darwin" });
  assert.notEqual(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /SKIP/);
});

test("unsupported encoding reports both decoder legs as skipped instead of empty passes", () => {
  const result = run({ empty: true });
  assert.equal(result.status, 0, result.output);
  assert.equal((result.output.match(/SKIP The encoder supports none/g) ?? []).length, 2);
  assert.deepEqual(result.calls, { Chrome: [], WebKit: [], closed: [] });
});
