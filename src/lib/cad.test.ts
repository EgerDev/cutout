import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createDeflate } from "node:zlib";
import { test } from "node:test";
import { rasterizeCad } from "./cad.ts";

/*
 * Hostile drawings run in a child process with a 512 MB heap so a regression
 * shows up as a failed test (OOM or timeout) instead of taking the runner down.
 * The child reports the CPU time the call burned (not wall time, so a busy machine
 * running other suites cannot fail it) and how far peak RSS rose during it.
 */
const CHILD = `
import { buffer } from "node:stream/consumers";
const { rasterizeCad } = await import(process.env.CAD_MODULE);
const bytes = new Uint8Array(await buffer(process.stdin));
const before = process.resourceUsage().maxRSS;
const started = process.cpuUsage();
let outcome;
try {
  outcome = (await rasterizeCad(new File([bytes], process.env.CAD_NAME), bytes)) ? "image" : "none";
} catch (error) {
  outcome = error?.name === "CutoutError" ? "CutoutError:" + error.code : "threw:" + error?.message;
}
const cpu = process.cpuUsage(started);
const ms = (cpu.user + cpu.system) / 1000;
const grewMB = (process.resourceUsage().maxRSS - before) / 1024;
console.log(JSON.stringify({ ms, grewMB, outcome }));
`;

function runHostile(name: string, bytes: Uint8Array, bounded = true) {
  const run = spawnSync(
    process.execPath,
    ["--max-old-space-size=512", "--input-type=module", "-e", CHILD],
    {
      input: bytes,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        CAD_MODULE: new URL("./cad.ts", import.meta.url).href,
        CAD_NAME: name,
      },
    },
  );
  assert.equal(
    run.status,
    0,
    `child ${run.signal ? `killed by ${run.signal}` : `exited ${run.status}`}: ${String(run.stderr).slice(-300)}`,
  );
  const report = JSON.parse(String(run.stdout).trim().split("\n").pop()!) as {
    ms: number;
    grewMB: number;
    outcome: string;
  };
  if (!bounded) return report.outcome;
  assert.ok(report.ms < 1000, `burned ${report.ms.toFixed(0)} ms of CPU`);
  assert.ok(report.grewMB < 200, `peak memory grew ${report.grewMB.toFixed(0)} MB`);
  return report.outcome;
}

const pair = (code: number, value: string | number) => `${code}\n${value}\n`;
const dxf = (entities: string, blocks = "") =>
  new TextEncoder().encode(
    (blocks ? pair(0, "SECTION") + pair(2, "BLOCKS") + blocks + pair(0, "ENDSEC") : "") +
      pair(0, "SECTION") +
      pair(2, "ENTITIES") +
      entities +
      pair(0, "ENDSEC") +
      pair(0, "EOF"),
  );
const line = (x: number) =>
  pair(0, "LINE") +
  pair(8, "0") +
  pair(10, x) +
  pair(20, 0) +
  pair(30, 0) +
  pair(11, x + 10) +
  pair(21, 10) +
  pair(31, 0);
const circle = (x: number) =>
  pair(0, "CIRCLE") + pair(8, "0") + pair(10, x) + pair(20, 5) + pair(30, 0) + pair(40, 3);
const insert = (block: string, x: number) =>
  pair(0, "INSERT") + pair(8, "0") + pair(2, block) + pair(10, x) + pair(20, 0) + pair(30, 0);

function nestedInserts(fan: number, levels: number) {
  let blocks = "";
  for (let b = 0; b < levels; b += 1) {
    blocks += pair(0, "BLOCK") + pair(8, "0") + pair(2, `B${b}`) + pair(70, 0);
    blocks += pair(10, 0) + pair(20, 0) + pair(30, 0) + pair(3, `B${b}`) + line(0);
    if (b + 1 < levels) for (let i = 0; i < fan; i += 1) blocks += insert(`B${b + 1}`, i);
    blocks += pair(0, "ENDBLK") + pair(8, "0");
  }
  return dxf(insert("B0", 0), blocks);
}

async function zlibOfZeros(megabytes: number) {
  const deflate = createDeflate({ level: 9 });
  const chunks: Buffer[] = [];
  deflate.on("data", (chunk: Buffer) => chunks.push(chunk));
  const zero = Buffer.alloc(1 << 20);
  for (let i = 0; i < megabytes; i += 1) deflate.write(zero);
  await new Promise((resolve) => deflate.end(resolve));
  return Buffer.concat(chunks);
}

const latin1 = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));

test("a DXF arc whose end angle is 1e8 degrees stays bounded", () => {
  const arc =
    pair(0, "ARC") +
    pair(8, "0") +
    pair(10, 0) +
    pair(20, 0) +
    pair(30, 0) +
    pair(40, 1) +
    pair(50, 0) +
    pair(51, 1e8);
  // Node has no canvas, so a bounded run ends with no image rather than an OOM.
  assert.equal(runHostile("arc.dxf", dxf(arc)), "none");
});

test("INSERTs nested 12 wide and 9 deep are refused as a drawing error", () => {
  assert.equal(runHostile("nest.dxf", nestedInserts(12, 9)), "CutoutError:drawing");
});

test("a DXF with more geometry than the point budget is refused as a drawing error", () => {
  // 20k circles × 65 points each is past CAD_MAX_POINTS.
  let entities = "";
  for (let i = 0; i < 20_000; i += 1) entities += circle(i);
  assert.equal(runHostile("many.dxf", dxf(entities)), "CutoutError:drawing");
});

test("one legacy-parsed polyline with more vertices than the point budget is refused", () => {
  // No SECTION header, so dxf-parser finds nothing and the line-pair parser takes over.
  const text = "0\nLWPOLYLINE\n" + "10\n1\n20\n2\n".repeat(1_100_000) + "0\nEOF\n";
  // Only the outcome is asserted: splitting an 11 MB file into lines costs time and memory
  // in proportion to its size, which CAD_MAX_BYTES bounds and this budget does not.
  assert.equal(runHostile("legacy.dxf", latin1(text), false), "CutoutError:drawing");
});

test("a PDF FlateDecode stream that inflates to 300 MB is not inflated past what the image needs", async () => {
  const bomb = await zlibOfZeros(300);
  const head = latin1(
    "%PDF-1.4\n1 0 obj << /Type /XObject /Subtype /Image /Width 16 /Height 16 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /FlateDecode >>\nstream\n",
  );
  const tail = latin1("\nendstream endobj\n%%EOF");
  const pdf = new Uint8Array(Buffer.concat([head, bomb, tail]));
  assert.equal(runHostile("bomb.pdf", pdf), "none");
});

test("1 MB of repeated JPEG start markers is scanned in linear time", () => {
  const bytes = new Uint8Array(1 << 20);
  for (let i = 0; i < bytes.length; i += 2) {
    bytes[i] = 0xff;
    bytes[i + 1] = 0xd8;
  }
  assert.equal(runHostile("soi.pdf", bytes), "none");
});

test("repeated DCTDecode / image markers are scanned in linear time", () => {
  const size = 2 << 20;
  const unit = "DCTDecode/Subtype/Image";
  // No stream at all, one stream only at the very end, and a stream after every
  // marker with a single endstream at the very end: each used to rescan the file.
  const inputs = [
    unit.repeat(size / unit.length),
    unit.repeat(size / unit.length) + "\nstream\n",
    "DCTDecode stream\n".repeat(size / 17) + "endstream",
  ];
  for (const text of inputs)
    assert.equal(runHostile("markers.pdf", latin1("%PDF-1.4\n" + text)), "none");
});

test("a valid DXF with a LINE and a CIRCLE still rasterises to a 1600 px PNG", async () => {
  const drawn: string[] = [];
  const canvas = {
    width: 0,
    height: 0,
    size: "",
    getContext: () =>
      new Proxy(
        {},
        {
          get: (_target, key) =>
            key === "save" || key === "restore" ? () => {} : () => drawn.push(String(key)),
          set: () => true,
        },
      ),
    toBlob(done: (blob: Blob) => void, type: string) {
      this.size = `${this.width}x${this.height}`;
      done(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type }));
    },
  };
  const scope = globalThis as { document?: unknown };
  scope.document = { createElement: () => canvas };
  try {
    const bytes = dxf(line(0) + circle(5));
    const file = await rasterizeCad(new File([bytes], "plan.dxf"), bytes);
    assert.ok(file instanceof File);
    assert.equal(file.type, "image/png");
    assert.equal(file.name, "plan.png");
    assert.equal(canvas.size, "1600x1600");
    assert.equal(drawn.filter((call) => call === "stroke").length, 2);
    assert.equal(drawn.filter((call) => call === "lineTo").length, 1 + 64);
  } finally {
    delete scope.document;
  }
});
