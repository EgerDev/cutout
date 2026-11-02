import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  jobs,
  tapTotals,
  uiFiles,
  checkFailed,
  skippedTestNames,
  passedTestNames,
  unexpectedSkips,
  verifySkips,
  REAL_MODEL_EXCLUSION,
  REAL_MODEL_PROFILE,
} from "./linux-ci.mjs";

test("Linux harness covers every npm suite in ci.yml", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const expected = [...workflow.matchAll(/npm run (test:[\w:]+|typecheck|lint|build)/g)].map(
    (m) => m[1],
  );
  const actual = Object.values(jobs)
    .flat()
    .map((s) => (["typecheck", "lint", "build"].includes(s) ? s : `test:${s}`));
  for (const name of expected) assert.ok(actual.includes(name), `Missing CI command: ${name}`);
  assert.deepEqual(Object.keys(jobs), ["test", "dev-server", "model-host", "docker"]);
});

test("TAP accounting includes both preamble and browser runs and preserves unavailable counts", () => {
  assert.deepEqual(
    tapTotals(
      "# tests 3\n# pass 2\n# fail 0\n# skipped 1\n# tests 7\n# pass 7\n# fail 0\n# skipped 0\n",
    ),
    { tests: 10, pass: 9, fail: 0, skipped: 1, cancelled: null, todo: null },
  );
  assert.equal(tapTotals("build complete").tests, null);
  assert.equal(tapTotals("ℹ tests 4\nℹ pass 3\nℹ skipped 1\n").skipped, 1);
});

test("UI splitting retains every declared file and refuses unparsed shell recipes", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const files = uiFiles(pkg.scripts["test:ui"]);
  // Every declared file, whatever the suite grows to (main has 12, C20 adds a 13th).
  assert.deepEqual(
    files,
    pkg.scripts["test:ui"].split(/\s+/).filter((token) => token.endsWith(".mjs")),
  );
  assert.ok(files.includes("scripts/browser-launch-confirm.mjs"));
  assert.equal(files.filter((file) => file.includes("browser-stage-")).length, 2);
  assert.throws(() => uiFiles("node --test script.mjs; true"));
});

test("cancelled Docker CLI success and missing summaries can never make a suite green", () => {
  const full = tapTotals("# tests 2\n# pass 2\n# fail 0\n# skipped 0\n");
  assert.equal(checkFailed(0, full, true), false);
  assert.equal(checkFailed(0, full, true, true), true);
  assert.equal(checkFailed(0, tapTotals(""), true), true);
  assert.equal(checkFailed(0, tapTotals("# tests 2\n"), true), true);
  assert.equal(checkFailed(0, tapTotals("# tests 0\n# pass 0\n"), true), true);
  assert.equal(checkFailed(0, tapTotals(""), false), false);
});

test("named skips are parsed from spec and TAP output and priced into the verdict", () => {
  const spec = [
    "✔ a passing case (1ms)",
    "﹣ P1 real integrity: page heals tampered onnx/model_fp16.onnx (0.1ms) # SKIP",
    "▶ group",
    "  ﹣ P1 real integrity: worker heals tampered config.json (0.1ms) # SKIP",
    "ℹ tests 3",
    "ℹ pass 1",
    "ℹ skipped 2",
  ].join("\n");
  assert.deepEqual(skippedTestNames(spec), [
    "P1 real integrity: page heals tampered onnx/model_fp16.onnx",
    "P1 real integrity: worker heals tampered config.json",
  ]);
  const tap = "ok 1 - alpha\nok 2 - P1 real integrity: fresh tampered JSON # SKIP\nok 3 - beta\n";
  assert.deepEqual(skippedTestNames(tap), ["P1 real integrity: fresh tampered JSON"]);
  // Skips count against pass+skip=test accounting only up to the tolerated number.
  const totals = tapTotals("ℹ tests 50\nℹ pass 40\nℹ skipped 10\n");
  assert.equal(checkFailed(0, totals, true, false, 10), false);
  assert.equal(checkFailed(0, totals, true, false, 9), true);
  assert.equal(checkFailed(0, { ...totals, pass: 41 }, true, false, 10), true);
});

test("the real-model exclusion names the exact ten opt-in cases in the suite file", () => {
  const declared = REAL_MODEL_EXCLUSION.cases;
  assert.equal(declared.length, REAL_MODEL_EXCLUSION.count);
  assert.equal(new Set(declared).size, declared.length);
  for (const name of declared) assert.ok(name.startsWith(REAL_MODEL_EXCLUSION.prefix));
  // The declared names mirror the loops and literals of the suite file: six
  // realm×file tamper-heal cases, one fresh-JSON case, three storage cases.
  const suite = readFileSync(new URL("./browser-model-cache.mjs", import.meta.url), "utf8");
  for (const literal of [
    '["page", "worker"]',
    '"onnx/model_fp16.onnx", "config.json", "preprocessor_config.json"',
    "P1 real integrity: a fresh tampered JSON fails once with actionable non-retryable copy",
    '["disabled", "absent", "denied"]',
    "Cache Storage cannot bypass the download check",
  ])
    assert.ok(suite.includes(literal), `suite file lost ${literal}`);
  assert.deepEqual(declared, [
    ...["page", "worker"].flatMap((realm) =>
      ["onnx/model_fp16.onnx", "config.json", "preprocessor_config.json"].map(
        (file) => `P1 real integrity: ${realm} heals tampered ${file}`,
      ),
    ),
    "P1 real integrity: a fresh tampered JSON fails once with actionable non-retryable copy",
    ...["disabled", "absent", "denied"].map(
      (storage) => `P1 real integrity: ${storage} Cache Storage cannot bypass the download check`,
    ),
  ]);
});

test("passed test names come from spec and TAP rows and drop directives", () => {
  const spec = [
    "✔ alpha (1.5ms)",
    "  ✔ nested pass (2ms)",
    "﹣ skipped one (0.1ms) # SKIP",
    "✖ failed one (3ms)",
    "✔ a todo row (0.1ms) # TODO",
    "▶ group",
  ].join("\n");
  assert.deepEqual(passedTestNames(spec), ["alpha", "nested pass"]);
  const tap =
    "ok 1 - alpha\nnot ok 2 - beta\nok 3 - gamma # SKIP\n    ok 4 - nested\nok 5 - delta # TODO\n";
  assert.deepEqual(passedTestNames(tap), ["alpha", "nested"]);
});

test("the exclusion matches the exact declared set, scoped to dev-server/advanced", () => {
  const declared = REAL_MODEL_EXCLUSION.cases;
  const scope = { job: "dev-server", step: "advanced" };
  assert.deepEqual(unexpectedSkips(declared, scope), []);
  // Any other name, a missing case or an extra declared-looking case all fail.
  assert.deepEqual(unexpectedSkips([...declared, "some other skip"], scope), ["some other skip"]);
  assert.deepEqual(unexpectedSkips(declared.slice(1), scope), [
    `missing declared case: ${declared[0]}`,
  ]);
  assert.equal(
    unexpectedSkips([...declared, `${REAL_MODEL_EXCLUSION.prefix} invented case`], scope).length,
    1,
  );
  // Ten copies of one declared name is not the declared set: nine repeats plus
  // the nine cases that never skipped.
  const repeated = unexpectedSkips(Array(10).fill(declared[0]), scope);
  assert.equal(repeated.filter((m) => m.startsWith("repeated declared case:")).length, 9);
  assert.equal(repeated.filter((m) => m.startsWith("missing declared case:")).length, 9);
  // Ten invented names sharing the prefix are not the declared set either:
  // every name is unknown and every declared case is missing.
  const invented = Array.from(
    { length: 10 },
    (_, i) => `${REAL_MODEL_EXCLUSION.prefix} invented ${i}`,
  );
  assert.equal(unexpectedSkips(invented, scope).length, 20);
  // The exclusion never applies outside its step or when real models are opted in.
  assert.deepEqual(unexpectedSkips(declared, { job: "dev-server", step: "ui" }), declared);
  assert.deepEqual(unexpectedSkips(declared, { job: "test", step: "advanced" }), declared);
  assert.deepEqual(unexpectedSkips(declared, { ...scope, realModels: true }), declared);
});

const FULL_SUMMARY = "ℹ tests 20\nℹ pass 10\nℹ fail 0\nℹ cancelled 0\nℹ skipped 10\nℹ todo 0\n";
const specSkips = (names) => names.map((name) => `﹣ ${name} (0.1ms) # SKIP`).join("\n");

test("--verify-skips accepts only the exact declared set or a strict no-skip run", () => {
  const declared = specSkips(REAL_MODEL_EXCLUSION.cases);
  assert.equal(verifySkips(`${declared}\n${FULL_SUMMARY}`).ok, true);
  // Indented TAP rows and a separate Node preamble summary still verify.
  const tap =
    "# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n" +
    REAL_MODEL_EXCLUSION.cases.map((name, i) => `    ok ${i + 1} - ${name} # SKIP`).join("\n") +
    "\n# tests 11\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 10\n# todo 0\n";
  assert.equal(verifySkips(tap).ok, true);
  // A strict run that skipped nothing is never a violation.
  assert.equal(
    verifySkips("ℹ tests 20\nℹ pass 20\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n").ok,
    true,
  );
  // One extra skip or a missing declared case fails; so does an unnamed skip.
  assert.equal(
    verifySkips(
      `${declared}\n﹣ rogue (1ms) # SKIP\n` +
        FULL_SUMMARY.replace("tests 20", "tests 21").replace("skipped 10", "skipped 11"),
    ).ok,
    false,
  );
  assert.equal(
    verifySkips(
      specSkips(REAL_MODEL_EXCLUSION.cases.slice(1)) +
        "\n" +
        FULL_SUMMARY.replace("tests 20", "tests 19").replace("skipped 10", "skipped 9"),
    ).ok,
    false,
  );
  assert.equal(verifySkips("ℹ skipped 1\n").ok, false);
});

test("--verify-skips rejects failed, cancelled, todo and incomplete logs", () => {
  const declared = specSkips(REAL_MODEL_EXCLUSION.cases);
  // A failed required test with the valid ten exclusions — a tee'd failure must not pass.
  assert.equal(
    verifySkips(
      `${declared}\nℹ tests 11\nℹ pass 0\nℹ fail 1\nℹ cancelled 0\nℹ skipped 10\nℹ todo 0\n`,
    ).ok,
    false,
  );
  // The same failure with no skips at all.
  assert.equal(
    verifySkips("ℹ tests 1\nℹ pass 0\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n").ok,
    false,
  );
  // Cancelled and todo markers are not a clean run.
  assert.equal(
    verifySkips(
      `${declared}\nℹ tests 12\nℹ pass 1\nℹ fail 0\nℹ cancelled 1\nℹ skipped 10\nℹ todo 0\n`,
    ).ok,
    false,
  );
  assert.equal(
    verifySkips(
      `${declared}\nℹ tests 12\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 10\nℹ todo 1\n`,
    ).ok,
    false,
  );
  // Missing or truncated summaries.
  assert.equal(verifySkips(declared).ok, false);
  assert.equal(verifySkips(`${declared}\nℹ tests 20\nℹ pass 10\n`).ok, false);
  assert.equal(verifySkips("").ok, false);
  // The summary does not account for every recorded test.
  assert.equal(
    verifySkips(
      `${declared}\nℹ tests 22\nℹ pass 10\nℹ fail 0\nℹ cancelled 0\nℹ skipped 10\nℹ todo 0\n`,
    ).ok,
    false,
  );
  // Named skips the summary does not count (or the other way round).
  assert.equal(
    verifySkips(
      `${declared}\nℹ tests 20\nℹ pass 10\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n`,
    ).ok,
    false,
  );
  // Duplicated and substituted declared names.
  assert.equal(
    verifySkips(`${specSkips(Array(10).fill(REAL_MODEL_EXCLUSION.cases[0]))}\n${FULL_SUMMARY}`).ok,
    false,
  );
  assert.equal(
    verifySkips(
      specSkips(
        Array.from({ length: 10 }, (_, i) => `${REAL_MODEL_EXCLUSION.prefix} invented ${i}`),
      ) + `\n${FULL_SUMMARY}`,
    ).ok,
    false,
  );
});

const DECLARED_LOG = [
  ...REAL_MODEL_EXCLUSION.cases.map((name) => `﹣ ${name} (0.1ms) # SKIP`),
  "ℹ tests 50",
  "ℹ pass 40",
  "ℹ fail 0",
  "ℹ cancelled 0",
  "ℹ skipped 10",
  "ℹ todo 0",
  "",
].join("\n");
const ALL_PASS_LOG = [
  ...REAL_MODEL_EXCLUSION.cases.map((name, i) => `ok ${i + 1} - ${name}`),
  "ℹ tests 50",
  "ℹ pass 50",
  "ℹ fail 0",
  "ℹ cancelled 0",
  "ℹ skipped 0",
  "ℹ todo 0",
].join("\n");

/**
 * A fake `docker` that records every call's arguments, emits the canned suite
 * output for step execs, and reports a container as existing or not.
 */
function fakeDockerHarness(tap, { inspectStatus = 0, mounts = "", workdir = "/srv/cutout-l20-src" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cutout-linux-ci-lane-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const argsFile = join(root, "docker-args.txt");
  const tapFile = join(root, "tap.txt");
  writeFileSync(tapFile, tap);
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${argsFile}"
if [ "$1" = "inspect" ]; then
  if [ "$2" = "-f" ]; then
    case " $* " in
      *WorkingDir*) printf '%s\\n' "${workdir}" ;;
      *) printf '%s\\n' "${mounts}" ;;
    esac
  fi
  exit ${inspectStatus}
fi
if [ "$1" = "exec" ]; then
  case " $* " in
    *setup-linux-browser*) exit 0 ;;
  esac
  cat "${tapFile}"
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  );
  const logs = join(root, "logs");
  mkdirSync(join(logs, "source", "scripts"), { recursive: true });
  writeFileSync(join(logs, "source", "scripts", "browser-ingest-low.mjs"), "// fixture\n");
  return {
    bin,
    logs,
    argsFile,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function invokeHarness(bin, argv) {
  return spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./linux-ci.mjs", import.meta.url)), ...argv],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        // The fake docker is an extensionless sh script, unspawnable on Windows;
        // route it through Git's sh via the harness's opt-in override, encoded as
        // a JSON argv array so spaced temp paths stay intact.
        ...(process.platform === "win32"
          ? { CUTOUT_DOCKER: JSON.stringify(["sh", join(bin, "docker")]) }
          : {}),
      },
      timeout: 10000,
    },
  );
}

test("the ordinary lane tolerates exactly the declared opt-in skips", () => {
  const { bin, logs, cleanup } = fakeDockerHarness(DECLARED_LOG);
  try {
    const result = invokeHarness(bin, [
      "--logs",
      logs,
      "--job",
      "dev-server",
      "--step",
      "advanced",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const row = JSON.parse(readFileSync(join(logs, "results.jsonl"), "utf8"));
    assert.equal(row.status, "pass");
    assert.equal(row.skipped, 10);
    assert.equal(row.excludedSkips, 10);
    assert.equal(row.skippedNames.length, REAL_MODEL_EXCLUSION.count);
  } finally {
    cleanup();
  }
});

test("an undeclared eleventh skip fails the ordinary lane by name", () => {
  const rogue =
    DECLARED_LOG.replace("ℹ pass 40", "ℹ pass 39").replace("ℹ skipped 10", "ℹ skipped 11") +
    "﹣ flaky neighbour (0.1ms) # SKIP\n";
  const { bin, logs, cleanup } = fakeDockerHarness(rogue);
  try {
    const result = invokeHarness(bin, [
      "--logs",
      logs,
      "--job",
      "dev-server",
      "--step",
      "advanced",
    ]);
    assert.equal(result.status, 1);
    const row = JSON.parse(readFileSync(join(logs, "results.jsonl"), "utf8"));
    assert.equal(row.status, "fail");
    assert.deepEqual(row.unexpectedSkips, ["flaky neighbour"]);
  } finally {
    cleanup();
  }
});

test("named skips the summary does not count fail the ordinary lane", () => {
  // Exactly the declared ten rows by name, but the summary counts none of them:
  // exclusions and suite totals must reconcile exactly, not stay under a cap.
  const contradictory = [
    ...REAL_MODEL_EXCLUSION.cases.map((name) => `﹣ ${name} (0.1ms) # SKIP`),
    "ℹ tests 11",
    "ℹ pass 1",
    "ℹ fail 0",
    "ℹ cancelled 0",
    "ℹ skipped 0",
    "ℹ todo 0",
    "",
  ].join("\n");
  const { bin, logs, cleanup } = fakeDockerHarness(contradictory);
  try {
    const result = invokeHarness(bin, [
      "--logs",
      logs,
      "--job",
      "dev-server",
      "--step",
      "advanced",
    ]);
    assert.equal(result.status, 1);
    const row = JSON.parse(readFileSync(join(logs, "results.jsonl"), "utf8"));
    assert.equal(row.status, "fail");
    assert.deepEqual(row.unexpectedSkips, ["10 named skip(s) have no matching summary count"]);
  } finally {
    cleanup();
  }
});

test("--real-models propagates the opt-in environment and persists the profile", () => {
  const { bin, logs, argsFile, cleanup } = fakeDockerHarness(ALL_PASS_LOG, {
    inspectStatus: 1,
  });
  try {
    const lock = join(logs, "..", "lock");
    const result = invokeHarness(bin, [
      "--logs",
      logs,
      "--job",
      "dev-server",
      "--step",
      "advanced",
      "--lock",
      lock,
      "--real-models",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(argsFile, "utf8");
    assert.ok(
      calls.includes(`:${REAL_MODEL_PROFILE}`),
      "container created without the persistent profile mount",
    );
    assert.ok(calls.includes("RUN_REAL_MODELS=1"), "opt-in flag never reached docker exec");
    assert.ok(
      calls.includes(`MODEL_CACHE_PROFILE=${REAL_MODEL_PROFILE}`),
      "profile path never reached docker exec",
    );
    assert.equal(existsSync(join(logs, "real-model-profile")), true);
    assert.equal(existsSync(lock), false);
    const rows = readFileSync(join(logs, "results.jsonl"), "utf8").trim().split("\n");
    const advanced = JSON.parse(rows.pop());
    assert.equal(advanced.realModels, true);
    assert.equal(advanced.skipped, 0);
  } finally {
    cleanup();
  }
});

test("--real-models requires each declared case to pass under its own name", () => {
  // Zero skips with no named pass rows proves nothing: the suite could have run
  // something else entirely. The strict lane fails without the declared ten.
  const { bin, logs, cleanup } = fakeDockerHarness(
    "ok 1 - an unrelated passing case\n" + ALL_PASS_LOG.slice(ALL_PASS_LOG.indexOf("ℹ tests")),
    { inspectStatus: 1 },
  );
  try {
    const result = invokeHarness(bin, [
      "--logs",
      logs,
      "--job",
      "dev-server",
      "--step",
      "advanced",
      "--lock",
      join(logs, "..", "lock"),
      "--real-models",
    ]);
    assert.equal(result.status, 1);
    const row = JSON.parse(
      readFileSync(join(logs, "results.jsonl"), "utf8").trim().split("\n").pop(),
    );
    assert.equal(row.status, "fail");
    assert.equal(row.skipped, 0);
    assert.equal(row.unexpectedSkips.length, REAL_MODEL_EXCLUSION.count);
    assert.match(row.unexpectedSkips[0], /^declared real-model case did not pass: /);
  } finally {
    cleanup();
  }
});

test("--real-models requires the shared lock and an updated container", () => {
  const { bin, logs, cleanup } = fakeDockerHarness(ALL_PASS_LOG, {
    mounts: "/tmp/cutout-profiles ",
  });
  try {
    const noLock = invokeHarness(bin, [
      "--logs",
      logs,
      "--job",
      "dev-server",
      "--step",
      "advanced",
      "--real-models",
    ]);
    assert.equal(noLock.status, 1);
    assert.match(noLock.stderr, /requires --lock/);
    const stale = invokeHarness(bin, [
      "--logs",
      logs,
      "--job",
      "dev-server",
      "--step",
      "advanced",
      "--lock",
      join(logs, "..", "lock"),
      "--real-models",
    ]);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /predates --real-models/);
  } finally {
    cleanup();
  }
});

test("a container from before the workdir change is migrated, not resumed", () => {
  const { bin, logs, argsFile, cleanup } = fakeDockerHarness(ALL_PASS_LOG, {
    workdir: "/work",
  });
  try {
    const migrated = invokeHarness(bin, [
      "--logs",
      logs,
      "--job",
      "dev-server",
      "--step",
      "install",
    ]);
    assert.equal(migrated.status, 0, migrated.stderr);
    const calls = readFileSync(argsFile, "utf8");
    assert.match(calls, /rm -f /, "stale container was never removed");
    assert.ok(calls.indexOf("rm -f") < calls.indexOf("run -d"), calls);
    assert.match(calls, /cp .*:\/srv\/cutout-l20-src/, "source copy never landed at the new workdir");
  } finally {
    cleanup();
  }
});

test("a single-step resume of a stale-workdir container refuses with a remedy", () => {
  const { bin, logs, cleanup } = fakeDockerHarness(ALL_PASS_LOG, {
    workdir: "/work",
  });
  try {
    const refused = invokeHarness(bin, [
      "--logs",
      logs,
      "--job",
      "dev-server",
      "--step",
      "advanced",
    ]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /predates the container workdir change/);
  } finally {
    cleanup();
  }
});

test("--verify-skips exits nonzero on an undeclared skip", () => {
  const root = mkdtempSync(join(tmpdir(), "cutout-linux-ci-verify-"));
  try {
    const log = join(root, "suite.log");
    writeFileSync(log, "﹣ flaky neighbour (0.1ms) # SKIP\nℹ skipped 1\n");
    const bad = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./linux-ci.mjs", import.meta.url)), "--verify-skips", log],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /flaky neighbour/);
    writeFileSync(log, DECLARED_LOG);
    const good = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./linux-ci.mjs", import.meta.url)), "--verify-skips", log],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(good.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed browser prerequisite is logged and releases the lock", () => {
  const root = mkdtempSync(join(tmpdir(), "cutout-linux-ci-test-"));
  try {
    const logs = join(root, "logs");
    mkdirSync(join(logs, "source", "scripts"), { recursive: true });
    writeFileSync(join(logs, "source", "scripts", "browser-ingest-low.mjs"), "// fixture\n");
    writeFileSync(
      join(root, "docker"),
      '#!/bin/sh\nif [ "$1" = "inspect" ] && [ "$2" = "-f" ]; then echo /srv/cutout-l20-src; exit 0; fi\nif [ "$1" = exec ]; then echo "fixture prerequisite failure" >&2; exit 17; fi\n',
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./linux-ci.mjs", import.meta.url)),
        "--logs",
        logs,
        "--job",
        "dev-server",
        "--step",
        "editor",
        "--lock",
        join(root, "lock"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${root}${delimiter}${process.env.PATH}`,
          // Same override as invokeHarness: an extensionless sh fake cannot be
          // spawned as "docker" on Windows.
          ...(process.platform === "win32"
            ? { CUTOUT_DOCKER: JSON.stringify(["sh", join(root, "docker")]) }
            : {}),
        },
        timeout: 10000,
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.equal(existsSync(join(root, "lock")), false);
    const row = JSON.parse(readFileSync(join(logs, "results.jsonl"), "utf8"));
    assert.equal(row.status, "fail");
    assert.equal(row.tests, null);
    assert.match(readFileSync(row.log, "utf8"), /fixture prerequisite failure/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
