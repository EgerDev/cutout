#!/usr/bin/env node
// Local Linux counterpart to ci.yml. Source is a clean clone; npm runs only in Linux.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const jobs = {
  test: [
    "install",
    "tools",
    "typecheck",
    "lint",
    "unit",
    "audit",
    "build",
    "server",
    "e2e",
    "heic",
    "csp",
    "a11y",
    "mobile",
    "routes",
    "ingest:audit",
  ],
  "dev-server": ["install", "ui", "editor", "removal", "formats", "advanced", "ui:audit"],
  "model-host": ["install", "mirror"],
  docker: ["stack"],
};

export function tapTotals(log) {
  const totals = {};
  for (const key of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
    const values = [...log.matchAll(new RegExp(`^(?:#|ℹ) ${key} (\\d+)$`, "gm"))];
    totals[key] = values.length ? values.reduce((n, m) => n + Number(m[1]), 0) : null;
  }
  return totals;
}

/**
 * The one declared ordinary-lane exclusion: the opt-in real-model integrity rows in
 * scripts/browser-model-cache.mjs skip unless RUN_REAL_MODELS=1, an environment the
 * container deliberately does not receive without --real-models. The complementary
 * gate is the real-model lane (--real-models here, or the Mac run): a Linux CPU
 * container only offers software WebGPU, so it never certifies hardware behaviour.
 * `cases` pins the contract to the suite file by exact name and multiplicity: a
 * renamed, added, dropped, duplicated or merely prefix-sharing case fails.
 */
export const REAL_MODEL_EXCLUSION = {
  job: "dev-server",
  step: "advanced",
  prefix: "P1 real integrity:",
  cases: [
    ...["page", "worker"].flatMap((realm) =>
      ["onnx/model_fp16.onnx", "config.json", "preprocessor_config.json"].map(
        (file) => `P1 real integrity: ${realm} heals tampered ${file}`,
      ),
    ),
    "P1 real integrity: a fresh tampered JSON fails once with actionable non-retryable copy",
    ...["disabled", "absent", "denied"].map(
      (storage) => `P1 real integrity: ${storage} Cache Storage cannot bypass the download check`,
    ),
  ],
};
REAL_MODEL_EXCLUSION.count = REAL_MODEL_EXCLUSION.cases.length;

/** In-container persistent Chrome profile for --real-models; host side is <logs>/real-model-profile. */
export const REAL_MODEL_PROFILE = "/tmp/real-model-profile";

/** Skipped test names from a node:test spec (`﹣`) or TAP (`ok N - … # SKIP`) log. */
export function skippedTestNames(log) {
  const names = [];
  for (const match of log.matchAll(/^\s*﹣\s+(.+?)(?:\s*\([\d.]+ms\))?\s*# SKIP\b.*$/gm))
    names.push(match[1]);
  for (const match of log.matchAll(/^\s*ok\s+\d+\s+-\s+(.+?)\s*# SKIP\b.*$/gm))
    names.push(match[1]);
  return names;
}

/**
 * Passed test names from a node:test spec (`✔`) or TAP (`ok N - …`) log. Rows
 * carrying a SKIP/TODO directive are excluded (spec prints todo cases as `✔`).
 */
export function passedTestNames(log) {
  const names = [];
  for (const match of log.matchAll(
    /^\s*✔\s+(.+?)(?:\s*\([\d.]+ ?ms\))?(?:\s+#\s*(SKIP|TODO)\b.*)?\s*$/gm,
  ))
    if (!match[2]) names.push(match[1]);
  for (const match of log.matchAll(/^\s*ok\s+\d+\s+-\s+(.+?)(?:\s+#\s*(SKIP|TODO)\b.*)?\s*$/gm))
    if (!match[2]) names.push(match[1]);
  return names;
}

/**
 * Skip names the declared exclusion does not cover. Scoped to its job/step: any
 * skip elsewhere, any non-real-model name, or a drifted count fails the step.
 * With realModels enabled nothing is tolerated — every case must execute.
 * Membership is the exact declared list with multiplicities: ten copies of one
 * real case, or ten unrelated names sharing the prefix, are not the exclusion.
 */
export function unexpectedSkips(names, { job, step, realModels = false }) {
  if (realModels || job !== REAL_MODEL_EXCLUSION.job || step !== REAL_MODEL_EXCLUSION.step)
    return names.slice();
  const counts = new Map(REAL_MODEL_EXCLUSION.cases.map((name) => [name, 0]));
  const unexpected = [];
  for (const name of names) {
    if (!counts.has(name)) {
      unexpected.push(name);
      continue;
    }
    counts.set(name, counts.get(name) + 1);
    if (counts.get(name) > 1) unexpected.push(`repeated declared case: ${name}`);
  }
  for (const [name, count] of counts) if (!count) unexpected.push(`missing declared case: ${name}`);
  return unexpected;
}

/**
 * Ordinary-lane verdict for a saved suite log (used by ci.yml and --verify-skips):
 * all skips must be exactly the declared exclusion set, and the suite summary
 * must be complete, consistent and failure-free — a log showing failed,
 * cancelled or todo tests, truncated totals, or skip lines the summary does not
 * account for is never ok. Nothing skipped at all also passes — a strict
 * real-model run is never a violation.
 */
export function verifySkips(log) {
  const names = skippedTestNames(log);
  const totals = tapTotals(log);
  const unexpected = names.length
    ? unexpectedSkips(names, { job: REAL_MODEL_EXCLUSION.job, step: REAL_MODEL_EXCLUSION.step })
    : [];
  const keys = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];
  if (!(totals.tests > 0) || keys.some((key) => totals[key] === null)) {
    unexpected.push("missing or incomplete suite summary in the log");
  } else {
    const accounted = totals.pass + totals.fail + totals.cancelled + totals.skipped + totals.todo;
    if (accounted !== totals.tests)
      unexpected.push(`suite summary accounts for ${accounted} of ${totals.tests} tests`);
    for (const key of ["fail", "cancelled", "todo"])
      if (totals[key] > 0) unexpected.push(`${totals[key]} ${key} test(s) in the log`);
    if (names.length !== totals.skipped)
      unexpected.push(
        totals.skipped > names.length
          ? `${totals.skipped - names.length} skipped test(s) left unnamed in the log`
          : `${names.length - totals.skipped} named skip(s) have no matching summary count`,
      );
  }
  return {
    ok: unexpected.length === 0,
    namedSkips: names,
    declared: `the exact ${REAL_MODEL_EXCLUSION.count} '${REAL_MODEL_EXCLUSION.prefix}' cases in scripts/browser-model-cache.mjs (${REAL_MODEL_EXCLUSION.job}/${REAL_MODEL_EXCLUSION.step})`,
    unexpected,
  };
}

export function checkFailed(code, totals, requireTests, timedOut = false, allowedSkips = 0) {
  const accounted =
    totals.tests > 0 && totals.pass !== null && totals.pass + allowedSkips === totals.tests;
  return (
    timedOut ||
    code !== 0 ||
    (requireTests && !accounted) ||
    ["fail", "cancelled", "todo"].some((key) => (totals[key] ?? 0) > 0) ||
    (totals.skipped ?? 0) > allowedSkips
  );
}

export function uiFiles(command) {
  const prefix = "node --test --test-concurrency=1 ";
  if (!command.startsWith(prefix)) throw new Error("Unsupported test:ui recipe");
  const files = command.slice(prefix.length).split(/\s+/);
  if (!files.length || files.some((file) => !/^scripts\/[\w.-]+\.mjs$/.test(file)))
    throw new Error("Unsupported test:ui file list");
  return files;
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The lane's `docker` binary resolves by bare name. On Windows CreateProcess only
// searches .exe, so a test double that is an extensionless sh script can never be
// spawned as "docker" there; CUTOUT_DOCKER overrides it as a JSON argv array
// (e.g. '["sh","C:/tools/docker-fake"]') so spaced paths stay unambiguous.
const DOCKER_CMD = process.env.CUTOUT_DOCKER
  ? JSON.parse(process.env.CUTOUT_DOCKER)
  : ["docker"];
if (
  !Array.isArray(DOCKER_CMD) ||
  DOCKER_CMD.length === 0 ||
  !DOCKER_CMD.every((arg) => typeof arg === "string" && arg.length > 0)
)
  throw new Error("CUTOUT_DOCKER must be a JSON array of non-empty strings");
const WORKDIR = "/srv/cutout-l20-src";
const dockerCall = (argv) => [DOCKER_CMD[0], [...DOCKER_CMD.slice(1), ...argv]];
const dockerSync = (argv, options) => spawnSync(...dockerCall(argv), options);
const dockerCapture = (argv) => capture(...dockerCall(argv));
function capture(cmd, args) {
  const p = spawnSync(cmd, args, { cwd: repo, encoding: "utf8" });
  if (p.status !== 0) throw new Error(`${cmd}: ${p.stderr || p.stdout}`);
  return p.stdout.trim();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "node scripts/linux-ci.mjs --logs ABSOLUTE_DIR [--ref HEAD] [--job all|test|dev-server|model-host|docker] [--step STEP] [--lock ABSOLUTE_DIR] [--port 9310] [--real-models] [--cleanup]\n" +
        "node scripts/linux-ci.mjs --verify-skips LOGFILE\n" +
        "Use one --step per invocation for bounded runs. Reuse --logs to resume; --cleanup removes only this run's containers/compose volumes. Never runs host npm or mounts node_modules.\n" +
        `Ordinary runs tolerate exactly ${REAL_MODEL_EXCLUSION.count} named skips: the '${REAL_MODEL_EXCLUSION.prefix}' opt-in cases in scripts/browser-model-cache.mjs, matched by exact name — a missing, renamed, extra or duplicated case fails — which need RUN_REAL_MODELS=1 and MODEL_CACHE_PROFILE that never enter the container unflagged. ` +
        `--real-models propagates both for the ${REAL_MODEL_EXCLUSION.step} step, persists the model cache at <logs>/real-model-profile, and requires --lock; it tolerates no skips and requires each declared case to pass under its own name, and it exercises software WebGPU, so the Mac run remains the hardware gate. ` +
        "--verify-skips checks a saved suite log against that declared exclusion set and its summary (exit 1 on any other, extra, missing or duplicated skip, and on a failed, cancelled, todo or incomplete run).",
    );
    return;
  }
  const verifyAt = args.indexOf("--verify-skips");
  if (verifyAt !== -1) {
    const file = args[verifyAt + 1];
    if (!file || args.length > 2)
      throw new Error("--verify-skips takes exactly one suite log file");
    const verdict = verifySkips(readFileSync(resolve(file), "utf8"));
    console.log(JSON.stringify(verdict));
    if (!verdict.ok) process.exitCode = 1;
    return;
  }
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cleanup") opts.cleanup = true;
    else if (args[i] === "--real-models") opts.realModels = true;
    else {
      if (
        !["--logs", "--ref", "--job", "--step", "--lock", "--port"].includes(args[i]) ||
        !args[i + 1]
      )
        throw new Error(`Invalid argument: ${args[i]}`);
      opts[args[i].slice(2)] = args[++i];
    }
  }
  if (!opts.logs) throw new Error("--logs is required (use a fresh directory for each commit)");
  if (opts.realModels && !opts.lock)
    throw new Error("--real-models requires --lock (the shared heavy-work/real-model lock)");
  const logs = resolve(opts.logs);
  mkdirSync(logs, { recursive: true });
  const id = `cutout-l20-${createHash("sha256").update(logs).digest("hex").slice(0, 10)}`;
  const source = resolve(logs, "source");
  const commit = capture("git", ["rev-parse", `${opts.ref || "HEAD"}^{commit}`]);
  const previous = resolve(logs, "commit");
  if (existsSync(previous) && readFileSync(previous, "utf8").trim() !== commit)
    throw new Error("Log directory belongs to another commit");
  writeFileSync(previous, `${commit}\n`);
  const selected = opts.job && opts.job !== "all" ? [opts.job] : Object.keys(jobs);
  for (const job of selected) if (!jobs[job]) throw new Error(`Unknown job: ${job}`);
  if (opts.step && !selected.every((job) => jobs[job].includes(opts.step)))
    throw new Error("--step must belong to the selected job");
  const port = Number(opts.port || 9310);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid port");
  // Declared before the signal handlers: interrupt must never see an uninitialised value.
  const compose = [
    "compose",
    "-p",
    id,
    "-f",
    resolve(source, "compose.yaml"),
    "-f",
    resolve(logs, "ports.yaml"),
  ];
  writeFileSync(
    resolve(logs, "ports.yaml"),
    `services:\n  proxy:\n    ports: !override\n      - "127.0.0.1:${port}:443"\n`,
  );
  const composeEnv = `export CUTOUT_DOMAIN=localhost GITHUB_SHA=${quote(commit)} CUTOUT_IMAGE=${id}:app; `;
  let lockHeld = false;
  let child;
  const release = () => {
    if (lockHeld) {
      rmSync(resolve(opts.lock, "owner"));
      rmSync(opts.lock, { recursive: true });
      lockHeld = false;
    }
  };
  const interrupt = (code) => {
    if (child) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
    }
    for (const job of Object.keys(jobs).filter((j) => j !== "docker"))
      dockerSync(["rm", "-f", `${id}-${job}`], { stdio: "ignore" });
    dockerSync([...compose, "down", "-v"], {
      env: { ...process.env, CUTOUT_DOMAIN: "localhost", CUTOUT_IMAGE: `${id}:app` },
      stdio: "ignore",
    });
    release();
    process.exit(code);
  };
  process.once("SIGTERM", () => interrupt(143));
  process.once("SIGINT", () => interrupt(130));
  async function run(job, step, cmd, argv) {
    if (opts.lock) {
      while (true) {
        try {
          mkdirSync(opts.lock);
          break;
        } catch (e) {
          if (e.code !== "EEXIST") throw e;
          await sleep(20);
        }
      }
      lockHeld = true;
      writeFileSync(
        resolve(opts.lock, "owner"),
        `L20 PID=${process.pid} start=${new Date().toISOString()} ${job}/${step}${opts.realModels ? " real-models" : ""}\n`,
      );
    }
    const stem = resolve(logs, `${job}-${step.replaceAll(":", "-")}`);
    let path = `${stem}.log`;
    for (let attempt = 2; existsSync(path); attempt++) path = `${stem}.attempt-${attempt}.log`;
    const fd = openSync(path, "w");
    const start = Date.now();
    writeFileSync(
      fd,
      `${JSON.stringify({ commit, cmd, args: argv, start: new Date(start).toISOString() })}\n`,
    );
    const requireTests = ![
      "container",
      "install",
      "tools",
      "typecheck",
      "lint",
      "audit",
      "build",
      "mirror",
      "stack",
      "cleanup",
    ].includes(step);
    let code;
    let totals;
    let finished;
    let timeout;
    let kill;
    let timedOut = false;
    try {
      if (cmd === "docker" && argv[0] === "exec") {
        dockerCapture(["start", `${id}-${job}`]);
        if (job === "dev-server" && step !== "install")
          dockerCapture(["exec", `${id}-${job}`, "node", "/tmp/setup-linux-browser.mjs"]);
        // Inside the step's recorded run, so a profile problem fails the step,
        // not the whole harness.
        if (opts.realModels && step === REAL_MODEL_EXCLUSION.step)
          dockerCapture([
            "exec",
            `${id}-${job}`,
            "bash",
            "-c",
            `mkdir -p ${REAL_MODEL_PROFILE} && chown -R pwuser:pwuser ${REAL_MODEL_PROFILE}`,
          ]);
      }
      const [spawnCmd, spawnArgv] = cmd === "docker" ? dockerCall(argv) : [cmd, argv];
      child = spawn(spawnCmd, spawnArgv, { cwd: source, detached: true, stdio: ["ignore", fd, fd] });
      timeout = setTimeout(() => {
        timedOut = true;
        process.kill(-child.pid, "SIGTERM");
      }, 570_000);
      kill = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (e) {
          if (e.code !== "ESRCH") throw e;
        }
      }, 580_000);
      code = await new Promise((yes, no) => {
        child.on("error", no);
        child.on("exit", (c) => yes(c ?? 124));
      });
    } catch (error) {
      writeFileSync(fd, `\n${error.stack || error}\n`);
      code = 1;
    } finally {
      clearTimeout(timeout);
      clearTimeout(kill);
      totals = tapTotals(readFileSync(path, "utf8"));
      const incompleteSuite = requireTests && !(totals.tests > 0 && totals.pass !== null);
      if (timedOut || incompleteSuite) {
        if (cmd === "docker" && argv[0] === "exec")
          dockerSync(["stop", "-t", "5", `${id}-${job}`]);
        if (job === "docker")
          dockerSync([...compose, "down", "-v"], {
            env: { ...process.env, CUTOUT_DOMAIN: "localhost", CUTOUT_IMAGE: `${id}:app` },
          });
      }
      finished = Date.now();
      child = undefined;
      closeSync(fd);
      release();
    }
    await sleep(200);
    const suiteLog = readFileSync(path, "utf8");
    const skipNames = skippedTestNames(suiteLog);
    const unexpected = unexpectedSkips(skipNames, {
      job,
      step,
      realModels: Boolean(opts.realModels),
    });
    // A strict run that reports zero skips still proves nothing unless each
    // declared case executed and passed under its own name.
    if (opts.realModels && job === REAL_MODEL_EXCLUSION.job && step === REAL_MODEL_EXCLUSION.step) {
      const passed = new Set(passedTestNames(suiteLog));
      for (const name of REAL_MODEL_EXCLUSION.cases)
        if (!passed.has(name)) unexpected.push(`declared real-model case did not pass: ${name}`);
    }
    // Named skips and the summary's skipped count must reconcile exactly, in
    // both directions — the same rule verifySkips applies to saved logs.
    const unaccounted = (totals.skipped ?? 0) - skipNames.length;
    if (unaccounted > 0) unexpected.push(`${unaccounted} skipped test(s) left unnamed in the log`);
    else if (unaccounted < 0)
      unexpected.push(`${-unaccounted} named skip(s) have no matching summary count`);
    const tolerated = unexpected.length ? 0 : skipNames.length;
    const failed =
      checkFailed(code, totals, requireTests, timedOut, tolerated) || unexpected.length > 0;
    const result = {
      commit,
      job,
      step,
      exit: timedOut ? 124 : code,
      cliExit: code,
      timedOut,
      status: failed ? "fail" : "pass",
      ...totals,
      ...(tolerated ? { excludedSkips: tolerated } : {}),
      ...(unexpected.length ? { unexpectedSkips: unexpected } : {}),
      ...(skipNames.length ? { skippedNames: skipNames } : {}),
      ...(opts.realModels ? { realModels: true } : {}),
      seconds: (finished - start) / 1000,
      log: path,
    };
    appendFileSync(resolve(logs, "results.jsonl"), `${JSON.stringify(result)}\n`);
    console.log(JSON.stringify(result));
    if (failed) throw new Error(`${job}/${step} failed; see ${path}`);
  }
  if (!existsSync(source)) {
    capture("git", ["clone", "--no-local", "--quiet", repo, source]);
    capture("git", ["-C", source, "checkout", "--detach", "--quiet", commit]);
  }
  if (opts.cleanup) {
    for (const job of Object.keys(jobs).filter((j) => j !== "docker"))
      dockerSync(["rm", "-f", `${id}-${job}`]);
    await run("docker", "cleanup", "bash", [
      "-c",
      `${composeEnv}${["docker", ...compose, "down", "-v", "--remove-orphans"].map(quote).join(" ")}`,
    ]);
    return;
  }
  const failures = [];
  // The real-model profile persists under the run's scratch dir whenever a job
  // can run the advanced suite; containers get the mount whether or not this
  // run enables --real-models, so a later mode change never meets an unmounted
  // container.
  const realModelProfileHost = resolve(logs, "real-model-profile");
  if (selected.some((job) => jobs[job].includes(REAL_MODEL_EXCLUSION.step)))
    mkdirSync(realModelProfileHost, { recursive: true });
  for (const job of selected) {
    if (job !== "docker") {
      const name = `${id}-${job}`;
      let containerExists = dockerSync(["inspect", name], { stdio: "ignore" }).status === 0;
      if (containerExists) {
        const workdir = dockerCapture(["inspect", "-f", "{{.Config.WorkingDir}}", name]).trim();
        if (workdir !== WORKDIR) {
          // A container created before the workdir change still holds its source
          // at the old path; a resumed run would copy out of a missing directory.
          // A single-step resume cannot migrate either: the fresh container would
          // lack the earlier install step's dependencies, so refuse with a remedy.
          if (opts.step && !["install", "tools"].includes(opts.step))
            throw new Error(
              `container ${name} predates the container workdir change; rerun the full ${job} job or at least its install step`,
            );
          dockerSync(["rm", "-f", name], { stdio: "ignore" });
          containerExists = false;
        }
      }
      if (!containerExists) {
        await run(job, "container", "docker", [
          "run",
          "-d",
          "--init",
          "--name",
          name,
          "--label",
          "cutout.audit=l20",
          "--shm-size=1g",
          "-w",
          WORKDIR,
          ...(jobs[job].includes(REAL_MODEL_EXCLUSION.step)
            ? ["-v", `${realModelProfileHost}:${REAL_MODEL_PROFILE}`]
            : []),
          "-e",
          `GITHUB_SHA=${commit}`,
          "-e",
          "ONNXRUNTIME_NODE_INSTALL_CUDA=skip",
          "-e",
          "CUTOUT_REQUIRE_E2E=1",
          "-e",
          `CUTOUT_EXPECT_COMMIT=${commit}`,
          "-e",
          "CUTOUT_BROWSER_PROFILE=/tmp/cutout-profiles",
          "mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27",
          "sleep",
          "infinity",
        ]);
        dockerCapture(["cp", `${source}/.`, `${name}:${WORKDIR}`]);
        dockerCapture(["cp", resolve(here, "install-wabt.sh"), `${name}:/tmp/install-wabt.sh`]);
        dockerCapture([
          "cp",
          resolve(here, "setup-linux-browser.mjs"),
          `${name}:/tmp/setup-linux-browser.mjs`,
        ]);
      } else if (opts.realModels && jobs[job].includes(REAL_MODEL_EXCLUSION.step)) {
        const mounts = dockerCapture([
          "inspect",
          "-f",
          "{{range .Mounts}}{{.Destination}} {{end}}",
          name,
        ]);
        if (!mounts.split(/\s+/).includes(REAL_MODEL_PROFILE))
          throw new Error(
            `${name} predates --real-models (no ${REAL_MODEL_PROFILE} mount); rerun after --cleanup or remove the container`,
          );
      }
      dockerCapture(["start", name]);
      dockerCapture(["cp", resolve(here, "install-wabt.sh"), `${name}:/tmp/install-wabt.sh`]);
      dockerCapture([
        "cp",
        resolve(here, "setup-linux-browser.mjs"),
        `${name}:/tmp/setup-linux-browser.mjs`,
      ]);
      const selectedIngest = readFileSync(
        resolve(source, "scripts/browser-ingest-low.mjs"),
        "utf8",
      );
      const boundedIngest = readFileSync(resolve(here, "browser-ingest-low.mjs"), "utf8");
      // Only overlay the exact legacy main/C20 test; its assertions stay unchanged.
      const ingestOverlay =
        createHash("sha256").update(selectedIngest).digest("hex") ===
        "1e0c2a59cfd6fe49fb9096775863bd3b8bdf962c8b586ea2733532cdfff8e8d6";
      if (ingestOverlay) {
        writeFileSync(resolve(logs, "bounded-ingest-harness.mjs"), boundedIngest);
        dockerCapture([
          "cp",
          resolve(logs, "bounded-ingest-harness.mjs"),
          `${name}:/tmp/l20-bounded-ingest.mjs`,
        ]);
      }
      for (const step of opts.step ? [opts.step] : jobs[job]) {
        dockerCapture(["start", name]);
        let script = "set -euo pipefail; export PATH=/tmp/tools/wabt-1.0.37/bin:$PATH; ";
        if (step === "install")
          script += `test $(node -p 'process.versions.node.split(".")[0]') = 24; test $(node -p 'JSON.parse(require("fs").readFileSync("package-lock.json")).packages["node_modules/playwright"].version') = 1.63.0; npm ci --ignore-scripts --no-audit --no-fund; node scripts/patch-dependencies.mjs; npx playwright install --with-deps chromium firefox webkit; mkdir -p /tmp/cutout-profiles; chown -R pwuser:pwuser ${WORKDIR} /tmp/cutout-profiles; node --version; npx playwright --version`;
        else if (step === "tools")
          script +=
            "if [ $(uname -m) = aarch64 ]; then apt-get update; apt-get install -y --no-install-recommends cmake g++ make xz-utils; fi; bash /tmp/install-wabt.sh /tmp/tools";
        else if (step === "audit") script += "npm audit --omit=dev --audit-level=moderate && npm audit --audit-level=high";
        else if (step === "unit") script += "CUTOUT_REQUIRE_TOOLS=1 npm run test:unit";
        else if (step === "mirror")
          script +=
            "VITE_MODEL_HOST=https://models.example/ npm run build; grep -rlq models.example .output/public/assets";
        else if (["typecheck", "lint", "build", "server"].includes(step))
          script += `npm run ${step === "server" ? "test:server" : step}`;
        else {
          const dev = job === "dev-server";
          const url = `http://127.0.0.1:${dev ? 8080 : 8081}/`;
          const start = dev
            ? "./node_modules/.bin/vite dev --host 127.0.0.1 --port 8080 --strictPort"
            : "HOST=127.0.0.1 PORT=8081 node .output/server/index.mjs";
          let suite = `npm run test:${step}`;
          if (step === "ingest:audit" && ingestOverlay) {
            suite = `cp scripts/browser-ingest-low.mjs /tmp/l20-original-ingest.mjs; cp /tmp/l20-bounded-ingest.mjs scripts/browser-ingest-low.mjs; trap 'cp /tmp/l20-original-ingest.mjs scripts/browser-ingest-low.mjs; kill $server 2>/dev/null || true; wait $server 2>/dev/null || true' EXIT; npm run test:ingest:audit`;
          }
          if (dev && step === "ui") {
            const files = uiFiles(
              JSON.parse(readFileSync(resolve(source, "package.json"), "utf8")).scripts["test:ui"],
            );
            // Only the synthetic graphics files need software WebGPU. C20 otherwise
            // chooses fp32 inference on Swiftshader instead of a real Linux CPU path.
            suite =
              "status=0; " +
              files
                .map(
                  (file) =>
                    `CUTOUT_SOFTWARE_WEBGPU=${file.includes("browser-stage-") ? "1" : "0"} node --test --test-concurrency=1 ${quote(file)} || status=1`,
                )
                .join("; ") +
              "; exit $status";
          }
          script += `${start} > /tmp/${job}-server.log 2>&1 & server=$!; trap 'kill $server 2>/dev/null || true; wait $server 2>/dev/null || true' EXIT; ready=; for i in $(seq 1 90); do if curl -fsS -o /dev/null ${url}${dev ? "manifest.webmanifest" : "healthz"}; then ready=1; break; fi; sleep 1; done; if [ -z "$ready" ]; then cat /tmp/${job}-server.log; exit 1; fi; export APP_URL=${url} DEV_URL=${url}; ${suite}`;
        }
        if (job === "dev-server" && step === "install")
          script += "; node /tmp/setup-linux-browser.mjs";
        try {
          await run(job, step, "docker", [
            "exec",
            ...(step === "install" || step === "tools"
              ? []
              : ["--user", "pwuser", "-e", "HOME=/home/pwuser"]),
            // The strict lane's opt-in environment crosses the container
            // boundary only here, only for the suite that honours it.
            ...(opts.realModels && step === REAL_MODEL_EXCLUSION.step
              ? ["-e", "RUN_REAL_MODELS=1", "-e", `MODEL_CACHE_PROFILE=${REAL_MODEL_PROFILE}`]
              : []),
            name,
            "bash",
            "-c",
            script,
          ]);
        } catch (e) {
          failures.push(e.message);
          if (["install", "build"].includes(step)) break;
          continue;
        }
        if (step === "build")
          dockerCapture(["cp", `${name}:${WORKDIR}/.output`, resolve(logs, "linux-output")]);
      }
    } else {
      const c = ["docker", ...compose].map(quote).join(" ");
      try {
        await run(job, "stack", "bash", [
          "-c",
          `set -e; ${composeEnv}cleanup() { ${c} logs > ${quote(resolve(logs, "compose.log"))} 2>&1; ${c} down -v; }; trap cleanup EXIT; ${c} up -d --build --wait; curl -fsSk --retry 10 --retry-all-errors --retry-delay 2 https://localhost:${port}/healthz; curl -fsSk https://localhost:${port}/version.json | grep -F ${quote(commit)}; test "$(curl --http1.1 -sk -o /dev/null -w '%{http_code}' https://localhost:${port}/%GG)" = 400; ! curl -fsSk --max-time 5 https://localhost:${port}/%GG`,
        ]);
      } catch (e) {
        failures.push(e.message);
      }
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
