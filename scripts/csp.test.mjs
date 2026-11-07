import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { inlineScriptHashes, policyFor } from "./csp.mjs";

const sha = (text) => `sha256-${createHash("sha256").update(text).digest("base64")}`;

const barrier = '(self.$R=self.$R||{})["tsr"]=[];self.$_TSR={h(){}}';
const reveal = "requestAnimationFrame(function(){$RT=performance.now()});";
const stream = "$RB=[];$RV=function(a){$RT=performance.now()};";
const html = `<!DOCTYPE html><html><head><title>x</title>
<script class="$tsr" id="$tsr-stream-barrier">${barrier}</script>
<script type="module" async="" src="/assets/index-abc.js"></script>
</head><body><div style="font-family:serif">hi</div>
<script>${reveal}</script><SCRIPT nonce="n">${stream}</SCRIPT>
<script src="/assets/other.js"></script></body></html>`;

test("hashes every inline script, in document order, and skips external ones", () => {
  assert.deepEqual(inlineScriptHashes(html), [sha(barrier), sha(reveal), sha(stream)]);
});

test("hashes an inline script byte for byte, whitespace and non-ASCII included", () => {
  const body = "\n  window.x = '…ü';\n";
  assert.deepEqual(inlineScriptHashes(`<script>${body}</script>`), [sha(body)]);
});

test("hashes the text the browser runs: HTML parsing turns NUL into U+FFFD and CRLF into LF", () => {
  // TanStack's dehydrated match ids contain NUL bytes; a raw-byte hash was blocked.
  assert.deepEqual(inlineScriptHashes('<script>a="x\0y";\r\nb=1;\rc=2</script>'), [
    sha('a="x�y";\nb=1;\nc=2'),
  ]);
});

test("a page without inline scripts has no hashes", () => {
  assert.deepEqual(inlineScriptHashes('<script src="/a.js"></script><p>hi</p>'), []);
});

test("hashes scripts closed by browser-accepted whitespace, attributes, or a trailing slash", () => {
  for (const end of [
    "</script >",
    "</SCRIPT\t\r\n\f>",
    '</script ignored="value">',
    "</script/>",
  ]) {
    assert.deepEqual(inlineScriptHashes(`<script>${barrier}${end}<script>${reveal}</script>`), [
      sha(barrier),
      sha(reveal),
    ]);
  }
});

test("script-like names inside a script do not terminate its body", () => {
  for (const text of ["</scriptx>", "</script-x>", "</script\u00a0>"]) {
    const body = `window.text = ${JSON.stringify(text)};`;
    assert.deepEqual(inlineScriptHashes(`<script>${body}</script>`), [sha(body)]);
  }
});

test("the page policy allows what Cutout needs and nothing it does not", () => {
  const policy = policyFor([sha(barrier)]);
  const directives = Object.fromEntries(
    policy.split(";").map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name, values];
    }),
  );
  assert.deepEqual(directives["default-src"], ["'self'"]);
  assert.deepEqual(directives["script-src"], ["'self'", "'wasm-unsafe-eval'", `'${sha(barrier)}'`]);
  assert.deepEqual(directives["style-src"], ["'self'", "'unsafe-inline'"]);
  assert.deepEqual(directives["img-src"], ["'self'", "blob:", "data:"]);
  // https: because ?src= may load an image from any https host.
  assert.deepEqual(directives["connect-src"], ["'self'", "blob:", "data:", "https:"]);
  assert.deepEqual(directives["worker-src"], ["'self'", "blob:"]);
  assert.deepEqual(directives["object-src"], ["'none'"]);
  assert.deepEqual(directives["base-uri"], ["'none'"]);
  assert.deepEqual(directives["form-action"], ["'none'"]);
  assert.deepEqual(directives["frame-ancestors"], ["'self'"]);
  assert.ok(!policy.includes("'unsafe-eval'"), "no eval");
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(policy), "no inline scripts beyond the hashes");
});

test("without hashes (worker scripts) the policy stays well-formed", () => {
  assert.match(policyFor([]), /script-src 'self' 'wasm-unsafe-eval'; style-src/);
});

test("the same hash twice appears once", () => {
  assert.equal(policyFor([sha(barrier), sha(barrier)]).split(sha(barrier)).length, 2);
});
