import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const configFile = resolve("vite.config.ts");
const vite = import.meta.resolve("vite");
function load(t, value, files = {}, mode = "production") {
  const cwd = mkdtempSync(join(tmpdir(), "cutout-model-host-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(cwd, file), text);
  const env = { ...process.env };
  delete env.VITE_MODEL_HOST;
  if (value !== undefined) env.VITE_MODEL_HOST = value;
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { loadConfigFromFile } from ${JSON.stringify(vite)};
    const loaded = await loadConfigFromFile(
      { command: "build", mode: ${JSON.stringify(mode)} }, ${JSON.stringify(configFile)}, process.cwd(),
    );
    console.log("MODEL_HOST=" + loaded.config.define["import.meta.env.VITE_MODEL_HOST"]);
  `,
    ],
    { cwd, env, encoding: "utf8" },
  );
}

test("configuration refuses malformed, insecure and non-base model URLs before building", (t) => {
  for (const value of [
    "http://nas.local/models/",
    "http://localhost:9000/models/",
    "http://127.0.0.1:9000/",
    "http://[::1]:9000/",
    "models.example.com",
    "/models/",
    "ftp://models.example.com/",
    "https://",
    "https:models.example.com",
    "https://models.example.com/?token=secret",
    "https://models.example.com/#models",
    "https://user:secret@models.example.com/",
    " https://models.example.com/",
    "https://models.example.com/with space/",
    "https://models.example.com\\models",
  ]) {
    const result = load(t, value);
    assert.notEqual(result.status, 0, `must reject ${value}`);
    assert.match(result.stderr, /VITE_MODEL_HOST.*HTTPS/, "a clear configuration error");
    assert.ok(!result.stderr.includes("secret"), "credentials and queries must not leak to logs");
  }
});

test("configuration defines the validated HTTPS mirror or the absent default", (t) => {
  for (const [value, expected] of [
    [undefined, ""],
    ["", ""],
    ["https://models.example.com/models", "https://models.example.com/models/"],
    ["https://localhost:9443/models/", "https://localhost:9443/models/"],
  ]) {
    const result = load(t, value);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`MODEL_HOST=${JSON.stringify(expected)}`), result.stdout);
  }
});

test("mode-specific env files and process overrides use the same model-host validation", (t) => {
  const files = {
    ".env": "VITE_MODEL_HOST=https://default.example/models/\n",
    ".env.production": "VITE_MODEL_HOST=http://localhost:9000/\n",
    ".env.development": "VITE_MODEL_HOST=https://dev.example/models/\n",
  };
  const invalid = load(t, undefined, files);
  assert.notEqual(invalid.status, 0, "a production .env override cannot bypass validation");
  assert.match(invalid.stderr, /VITE_MODEL_HOST.*HTTPS/);
  const dev = load(t, undefined, files, "development");
  assert.equal(dev.status, 0, dev.stderr);
  assert.ok(dev.stdout.includes('MODEL_HOST="https://dev.example/models/"'), dev.stdout);
  const override = load(t, "https://override.example/models/", files);
  assert.equal(override.status, 0, override.stderr);
  assert.ok(
    override.stdout.includes('MODEL_HOST="https://override.example/models/"'),
    override.stdout,
  );
});
