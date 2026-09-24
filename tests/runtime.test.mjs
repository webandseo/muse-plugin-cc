import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeAuth, installFakeModelCatalog, installFakeMuse } from "./fake-muse-fixture.mjs";
import { commitFile, initGitRepo, makeTempDir, run, runNode, withEnv } from "./helpers.mjs";
import {
  generateJobId,
  listJobs,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "../plugins/muse/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "muse");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "muse-bridge.mjs");

function setup(options = {}) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const home = makeTempDir();
  const fakeLog = path.join(pluginDataDir, "fake-muse.log");
  const fake = installFakeMuse(binDir, options.scenario ?? "default");
  installFakeAuth(home, { loggedIn: options.loggedIn !== false });
  if (options.catalog !== false) {
    installFakeModelCatalog(home);
  }
  initGitRepo(repo);
  commitFile(repo, "src.js", "export const value = 1;\n", "init");
  if (options.dirty !== false) {
    fs.writeFileSync(path.join(repo, "src.js"), "export const value = 2;\n");
  }
  const env = buildEnv(fake, {
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    FAKE_MUSE_LOG: fakeLog,
    HOME: home,
    USERPROFILE: home,
    ...(options.env ?? {})
  });
  delete env.META_API_KEY;
  delete env.XDG_CONFIG_HOME;
  delete env.XDG_DATA_HOME;
  delete env.MUSE_CC_SESSION_ID;
  delete env.MUSE_CC_FOREIGN_CONTEXT;
  delete env.MUSE_CC_MODEL;
  return { repo, binDir, pluginDataDir, home, fake, fakeLog, env };
}

function writeClaudeTranscript(home, name = "sess-transfer.jsonl") {
  const projects = path.join(home, ".claude", "projects", "demo");
  fs.mkdirSync(projects, { recursive: true });
  const sessionPath = path.join(projects, name);
  const lines = [
    { type: "user", sessionId: "cs-1", message: { role: "user", content: "<system-reminder>ignore</system-reminder>Please fix the widget" } },
    {
      type: "assistant",
      sessionId: "cs-1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret" },
          { type: "text", text: "Looking at widget.js now." },
          { type: "tool_use", name: "Read", input: { file_path: "widget.js" } }
        ]
      }
    },
    { type: "user", sessionId: "cs-1", message: { role: "user", content: [{ type: "tool_result", content: "export const w = 1;" }] } }
  ];
  fs.writeFileSync(sessionPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return sessionPath;
}

function bridge(args, cwd, env) {
  return runNode([SCRIPT, ...args], { cwd, env });
}

function execArgvs(logPath) {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.argv?.[0] === "exec")
    .map((entry) => entry.argv);
}

function startSleeper(cwd) {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
    cwd,
    stdio: "ignore",
    detached: process.platform !== "win32"
  });
  child.unref();
  return child.pid;
}

function exitedPid() {
  return Number(runNode(["-e", "process.stdout.write(String(process.pid))"]).stdout);
}

function seedTaskJob(repo, env, overrides = {}) {
  return withEnv({ CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA }, () => {
    const now = new Date().toISOString();
    const job = {
      id: generateJobId("run"),
      kind: "task",
      kindLabel: "delegate",
      title: "Muse Code Delegate",
      workspaceRoot: repo,
      jobClass: "task",
      summary: "write run already in flight",
      status: "running",
      phase: "editing",
      write: true,
      createdAt: now,
      updatedAt: now,
      ...overrides
    };
    writeJobFile(repo, job.id, job);
    upsertJob(repo, job);
    return job;
  });
}

/**
 * Drive every bridge path that launches `muse exec` (review, critique, a
 * read-only and a write-capable run, transfer, check --probe, and the
 * stop-review gate) and return the exec argv of each launch.
 */
function runEveryExecPath(context, extraEnv = {}) {
  const { repo, env, home, fakeLog } = context;
  const runEnv = { ...env, ...extraEnv };
  const sessionPath = writeClaudeTranscript(home);
  const commands = [
    ["review"],
    ["critique"],
    ["run", "look around"],
    ["run", "--write", "make the change"],
    ["transfer", "--source", sessionPath],
    ["check", "--probe"]
  ];
  for (const args of commands) {
    const result = bridge(args, repo, runEnv);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  }
  bridge(["check", "--enable-review-gate"], repo, runEnv);
  const gate = runNode([path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs")], {
    cwd: repo,
    env: runEnv,
    input: JSON.stringify({ session_id: "s", cwd: repo, last_assistant_message: "Edited src.js" })
  });
  assert.equal(gate.status, 0, gate.stderr);
  const argvs = execArgvs(fakeLog);
  assert.equal(argvs.length, commands.length + 1, "one exec per command plus the stop gate");
  return argvs;
}

function lastExecArgv(logPath) {
  const lines = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const execRun = [...lines].reverse().find((entry) => entry.argv?.[0] === "exec");
  assert.ok(execRun, "expected a headless muse exec invocation");
  return execRun.argv;
}

test("check reports ready with the fake muse and auth file", () => {
  const { repo, env } = setup();
  const result = bridge(["check", "--json"], repo, env);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.muse.available, true);
  assert.ok(payload.launcher.binary.endsWith("fake-muse.mjs"));
  // git reports the root with forward slashes and canonical casing.
  assert.equal(
    payload.workspace.root.replace(/\\/g, "/").toLowerCase(),
    fs.realpathSync.native(repo).replace(/\\/g, "/").toLowerCase()
  );
  assert.equal(payload.node.available, true);
  assert.equal(payload.git.available, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.reviewGateEnabled, false);
  assert.equal(payload.sessionRuntime.mode, "plugin-owned");
  assert.equal(payload.models.default, "muse-spark-1.3-contributor");
  assert.deepEqual(payload.models.available, ["muse-spark-1.3", "muse-spark-1.3-contributor"], "hidden rows are excluded");
  assert.match(payload.models.note, /product improvement/);
  assert.equal(payload.models.aliases.spark, "muse-spark-1.3");
});

test("check reports the Windows sandbox state and the opt-out env passes --disable-sandbox", { skip: process.platform !== "win32" }, () => {
  const { repo, env, fakeLog } = setup();
  const notReady = bridge(["check", "--json"], repo, { ...env, FAKE_MUSE_SANDBOX: "setup_required" });
  assert.equal(notReady.status, 0, notReady.stderr);
  const payload = JSON.parse(notReady.stdout);
  assert.equal(payload.sandbox.checked, true);
  assert.equal(payload.sandbox.ready, false);
  assert.ok(payload.nextSteps.some((step) => /muse sandbox windows setup/.test(step)));
  const text = bridge(["check"], repo, { ...env, FAKE_MUSE_SANDBOX: "setup_required" });
  assert.match(text.stdout, /- windows sandbox: setup_required/);

  const ready = JSON.parse(bridge(["check", "--json"], repo, env).stdout);
  assert.equal(ready.sandbox.ready, true);

  bridge(["run", "--write", "shell work"], repo, env);
  assert.ok(!lastExecArgv(fakeLog).includes("--disable-sandbox"), "sandbox stays on by default");
  bridge(["run", "--write", "shell work"], repo, { ...env, MUSE_CC_DISABLE_SANDBOX: "1" });
  assert.ok(lastExecArgv(fakeLog).includes("--disable-sandbox"), "opt-out env disables it");
  bridge(["run", "read only"], repo, { ...env, MUSE_CC_DISABLE_SANDBOX: "1" });
  assert.ok(!lastExecArgv(fakeLog).includes("--disable-sandbox"), "read-only runs never disable it");
});

test("check explains a missing model catalog", () => {
  const { repo, env } = setup({ catalog: false });
  const result = bridge(["check", "--json"], repo, env);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.models.available, []);
  assert.match(payload.models.detail, /not cached yet/);
  const text = bridge(["check"], repo, env);
  assert.match(text.stdout, /- models: catalog not cached yet/);
});

test("check reports not ready when no provider is authenticated", () => {
  const { repo, env } = setup({ loggedIn: false });
  const result = bridge(["check", "--json"], repo, env);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.ok(payload.nextSteps.some((step) => /muse login/.test(step)));
});

test("check --probe verifies auth with a one-step exec", () => {
  const { repo, env, fakeLog } = setup();
  const result = bridge(["check", "--json", "--probe"], repo, env);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.auth.verified, true);
  const argv = lastExecArgv(fakeLog);
  assert.equal(argv[argv.indexOf("--max-model-steps") + 1], "1");
});

test("check toggles the review gate and renders the text report", () => {
  const { repo, env } = setup();
  const enabled = bridge(["check", "--json", "--enable-review-gate"], repo, env);
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(JSON.parse(enabled.stdout).reviewGateEnabled, true);

  const text = bridge(["check"], repo, env);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /# Muse Code Check/);
  assert.match(text.stdout, /review gate: enabled/);
  assert.match(text.stdout, /launcher: .*fake-muse\.mjs/);

  const disabled = bridge(["check", "--json", "--disable-review-gate"], repo, env);
  assert.equal(JSON.parse(disabled.stdout).reviewGateEnabled, false);
});

test("review renders the fake reviewer output and runs read-only", () => {
  const { repo, env, fakeLog } = setup();
  const result = bridge(["review"], repo, env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Muse Code Review/);
  assert.match(result.stdout, /Target: working tree diff/);
  assert.match(result.stdout, /No material issues found/);

  const argv = lastExecArgv(fakeLog);
  assert.ok(argv.includes("--disable-write"), argv.join(" "));
  assert.ok(argv.includes("--disable-shell"), argv.join(" "));
  assert.ok(argv.includes("--disable-web-tools"), argv.join(" "));
  assert.ok(argv.includes("--disable-approval"), argv.join(" "));
  assert.ok(!argv.includes("--trust-workspace"), argv.join(" "));
  assert.ok(!argv.includes("--output-schema"), argv.join(" "));
});

test("review inlines the diff into the prompt file", () => {
  const { repo, env, fakeLog } = setup();
  const result = bridge(["review", "--json"], repo, env);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.review, "Review");
  assert.equal(payload.context.inputMode, "inline-diff");
  assert.equal(payload.model, "muse-spark-fake");
  assert.ok(payload.threadId);
  lastExecArgv(fakeLog);
});

test("critique returns structured findings through --output-schema", () => {
  const { repo, env, fakeLog } = setup();
  const result = bridge(["critique", "--json", "focus on docs"], repo, env);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.review, "Critique");
  assert.equal(payload.result?.verdict, "approve");
  assert.ok(Array.isArray(payload.result?.findings));
  const argv = lastExecArgv(fakeLog);
  assert.ok(argv.includes("--output-schema"), argv.join(" "));

  const rendered = bridge(["critique"], repo, env);
  assert.match(rendered.stdout, /# Muse Code Critique/);
  assert.match(rendered.stdout, /Verdict: approve/);
  assert.match(rendered.stdout, /No material findings/);
});

test("review and critique forward --model and --effort", () => {
  const { repo, env, fakeLog } = setup();
  for (const command of ["review", "critique"]) {
    const result = bridge([command, "--model", "muse-spark-1.3", "--effort", "xhigh"], repo, env);
    assert.equal(result.status, 0, result.stderr);
    const argv = lastExecArgv(fakeLog);
    assert.equal(argv[argv.indexOf("--model") + 1], "muse-spark-1.3");
    assert.equal(argv[argv.indexOf("--reasoning-effort") + 1], "xhigh");
  }
});

test("every muse exec the bridge launches passes --no-foreign-personal-context", () => {
  for (const argv of runEveryExecPath(setup())) {
    assert.ok(argv.includes("--no-foreign-personal-context"), argv.join(" "));
  }
});

test("MUSE_CC_FOREIGN_CONTEXT=1 lets Muse load foreign personal context again", () => {
  const { repo, env, fakeLog } = setup();
  for (const args of [["review"], ["run", "--write", "make the change"]]) {
    const result = bridge(args, repo, { ...env, MUSE_CC_FOREIGN_CONTEXT: "1" });
    assert.equal(result.status, 0, result.stderr);
  }
  const argvs = execArgvs(fakeLog);
  assert.equal(argvs.length, 2);
  for (const argv of argvs) {
    assert.ok(!argv.includes("--no-foreign-personal-context"), argv.join(" "));
  }
});

test("every command defaults to muse-spark-1.3 when no model is given", () => {
  for (const argv of runEveryExecPath(setup())) {
    assert.ok(argv.includes("--model"), argv.join(" "));
    assert.equal(argv[argv.indexOf("--model") + 1], "muse-spark-1.3", argv.join(" "));
  }
});

test("MUSE_CC_MODEL takes aliases or full ids, and --model still wins", () => {
  const { repo, env, fakeLog } = setup();
  const modelOf = (args, extraEnv) => {
    const result = bridge(args, repo, { ...env, ...extraEnv });
    assert.equal(result.status, 0, result.stderr);
    const argv = lastExecArgv(fakeLog);
    return argv[argv.indexOf("--model") + 1];
  };
  assert.equal(modelOf(["review"], { MUSE_CC_MODEL: "contributor" }), "muse-spark-1.3-contributor");
  assert.equal(modelOf(["run", "--write", "make the change"], { MUSE_CC_MODEL: "contributor" }), "muse-spark-1.3-contributor");
  assert.equal(modelOf(["review"], { MUSE_CC_MODEL: "muse-spark-1.2" }), "muse-spark-1.2", "full ids pass through");
  assert.equal(modelOf(["review", "--model", "spark"], { MUSE_CC_MODEL: "contributor" }), "muse-spark-1.3", "--model beats MUSE_CC_MODEL");
});

test("check reports which model the plugin will use and why", () => {
  const { repo, env, fakeLog } = setup();
  const byDefault = JSON.parse(bridge(["check", "--json"], repo, env).stdout);
  assert.equal(byDefault.models.selected.id, "muse-spark-1.3");
  assert.equal(byDefault.models.selected.source, "default");
  assert.equal(byDefault.models.default, "muse-spark-1.3-contributor", "Muse's own default is still reported");
  const text = bridge(["check"], repo, env).stdout;
  assert.match(text, /- model: muse-spark-1\.3 \(plugin default/);

  const fromEnv = JSON.parse(bridge(["check", "--json"], repo, { ...env, MUSE_CC_MODEL: "contributor" }).stdout);
  assert.equal(fromEnv.models.selected.id, "muse-spark-1.3-contributor");
  assert.equal(fromEnv.models.selected.source, "env");
  assert.match(fromEnv.models.selected.detail, /MUSE_CC_MODEL=contributor/);
  assert.match(fromEnv.models.selected.detail, /product improvement/, "the catalog note follows the selected model");

  const fromFlag = bridge(["check", "--json", "--probe", "--model", "spark-1.2"], repo, { ...env, MUSE_CC_MODEL: "contributor" });
  assert.equal(fromFlag.status, 0, fromFlag.stderr);
  const flagPayload = JSON.parse(fromFlag.stdout);
  assert.equal(flagPayload.models.selected.id, "muse-spark-1.2");
  assert.equal(flagPayload.models.selected.source, "flag");
  const argv = lastExecArgv(fakeLog);
  assert.equal(argv[argv.indexOf("--model") + 1], "muse-spark-1.2", "the probe uses the selected model");
});

test("review rejects unsupported --effort values", () => {
  const { repo, env } = setup();
  for (const effort of ["extreme", "turbo", "9000"]) {
    const result = bridge(["review", "--effort", effort], repo, env);
    assert.notEqual(result.status, 0, `expected rejection for --effort ${effort}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /Unsupported reasoning effort/i);
  }
});

test("review --base uses a branch diff target", () => {
  const { repo, env } = setup({ dirty: false });
  run("git", ["checkout", "-q", "-b", "feature"], { cwd: repo, shell: false });
  commitFile(repo, "feature.js", "export const feature = true;\n", "feature");
  const result = bridge(["review", "--json", "--base", "main"], repo, env);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.target.mode, "branch");
  assert.equal(payload.target.baseRef, "main");
});

test("run delegates through the fake muse and stores a finished job", () => {
  const { repo, env, fakeLog } = setup();
  const result = bridge(["run", "check auth preflight"], repo, env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
  assert.match(result.stdout, /Resume in Muse: muse resume [0-9a-f-]{36}/);

  const argv = lastExecArgv(fakeLog);
  assert.ok(argv.includes("--disable-write"), "read-only by default");
  assert.ok(argv.includes("--disable-shell"), "no shell by default");
  assert.ok(argv.includes("--trust-workspace"), "delegate runs load workspace skills");

  withEnv({ CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA }, () => {
    const jobs = listJobs(repo);
    assert.ok(jobs.length >= 1);
    assert.equal(jobs[0].jobClass, "task");
    assert.equal(jobs[0].status, "completed");
    assert.ok(jobs[0].threadId);
  });
});

test("run --write enables shell and writes", () => {
  const { repo, env, fakeLog } = setup();
  const result = bridge(["run", "--write", "make the change"], repo, env);
  assert.equal(result.status, 0, result.stderr);
  const argv = lastExecArgv(fakeLog);
  assert.ok(!argv.includes("--disable-write"), argv.join(" "));
  assert.ok(!argv.includes("--disable-shell"), argv.join(" "));
  assert.ok(argv.includes("--disable-approval"), argv.join(" "));
});

test("run resolves model aliases and forwards --image", () => {
  const { repo, env, fakeLog } = setup();
  const image = path.join(repo, "shot.png");
  fs.writeFileSync(image, "not really a png", "utf8");
  const result = bridge(["run", "--model", "spark", "--image", "shot.png", "look at the screenshot"], repo, env);
  assert.equal(result.status, 0, result.stderr);
  const argv = lastExecArgv(fakeLog);
  assert.equal(argv[argv.indexOf("--model") + 1], "muse-spark-1.3");
  // The bridge resolves against process.cwd(), which is a real path (macOS /private/var).
  assert.equal(fs.realpathSync(argv[argv.indexOf("--image") + 1]), fs.realpathSync(image));

  const missing = bridge(["run", "--image", "nope.png", "look"], repo, env);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Image not found/);
});

test("run --write refuses to start while another write-capable run is alive", () => {
  const { repo, env, fakeLog } = setup();
  const bridgePid = startSleeper(repo);
  try {
    const active = seedTaskJob(repo, env, { bridgePid, pid: bridgePid });
    for (const args of [
      ["run", "--write", "make the change"],
      ["run", "--write", "--background", "make the change"],
      ["run", "--write", "--json", "make the change"]
    ]) {
      const refused = bridge(args, repo, env);
      assert.notEqual(refused.status, 0, `${args.join(" ")} must be refused`);
      assert.match(refused.stderr, new RegExp(`${active.id} is still running`));
      assert.ok(refused.stderr.includes(`/muse:runs ${active.id} --wait`), refused.stderr);
      assert.ok(refused.stderr.includes(`/muse:stop ${active.id}`), refused.stderr);
    }
    assert.deepEqual(execArgvs(fakeLog), [], "no muse exec may start while the other write run is alive");
    withEnv({ CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA }, () => {
      const jobs = listJobs(repo);
      assert.equal(jobs.length, 1, "refused runs are not recorded");
      assert.equal(jobs[0].status, "running", "the live run is left alone");
    });

    const readOnly = bridge(["run", "look around without editing"], repo, env);
    assert.equal(readOnly.status, 0, readOnly.stderr);

    const allowed = bridge(["run", "--write", "--allow-concurrent", "parallel on purpose"], repo, env);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(execArgvs(fakeLog).length, 2);
  } finally {
    try {
      process.kill(bridgePid, "SIGKILL");
    } catch {
    }
  }
});

test("run --write retires a write-capable run whose processes are gone and starts", () => {
  const { repo, env, fakeLog } = setup();
  const deadPid = exitedPid();
  const stale = seedTaskJob(repo, env, { bridgePid: deadPid, pid: deadPid, agentPid: exitedPid() });

  const result = bridge(["run", "--write", "make the change"], repo, env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(execArgvs(fakeLog).length, 1);
  withEnv({ CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA }, () => {
    const retired = listJobs(repo).find((job) => job.id === stale.id);
    assert.equal(retired.status, "failed");
    assert.match(retired.errorMessage, /no longer running/);
  });
});

test("foreground run announces its run id for follow-up commands", () => {
  const { repo, env } = setup();
  const result = bridge(["run", "--write", "make the change"], repo, env);
  assert.equal(result.status, 0, result.stderr);
  const runId = withEnv({ CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA }, () => listJobs(repo)[0].id);
  assert.ok(result.stderr.includes(`Tracking this run as ${runId}`), result.stderr);
  assert.ok(result.stderr.includes(`/muse:runs ${runId} --wait`), result.stderr);
});

test("run --write --worktree runs Muse in an isolated worktree and reports it", () => {
  const { repo, env, fakeLog } = setup();
  const result = bridge(["run", "--json", "--write", "--worktree", "--worktree-base", "main", "risky refactor"], repo, env);
  assert.equal(result.status, 0, result.stderr);
  const argv = lastExecArgv(fakeLog);
  const payload = JSON.parse(result.stdout);
  // The bridge creates the worktree with git and hands it to Muse as existing.
  assert.equal(argv[argv.indexOf("--worktree") + 1], "existing");
  assert.equal(argv[argv.indexOf("--worktree-existing") + 1], payload.worktree.path);
  assert.equal(argv[argv.indexOf("--session-id") + 1], payload.threadId);
  assert.match(payload.worktree.path.replace(/\\/g, "/"), /\.muse\/worktrees\/.+-[0-9a-f-]{36}$/);
  assert.equal(payload.worktree.branch, `muse/session-${payload.threadId}`);
  // The worktree starts from HEAD, not from the dirty main checkout that setup() leaves behind.
  assert.match(fs.readFileSync(path.join(payload.worktree.path, "src.js"), "utf8"), /value = 1/);
  assert.ok(
    fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8").includes("/.muse/worktrees/"),
    "worktree dir excluded from git status"
  );
  assert.equal(run("git", ["status", "--short"], { cwd: repo, shell: false }).stdout.trim(), "M src.js", "main checkout unchanged by the run");

  const rendered = bridge(["run", "--write", "--worktree", "risky refactor"], repo, env);
  assert.match(rendered.stdout, /Worktree: .*\.muse[\\/]worktrees[\\/]/);

  const shown = bridge(["runs"], repo, env);
  assert.match(shown.stdout, /Worktree: .*\.muse[\\/]worktrees[\\/]/);

  const readOnly = bridge(["run", "--worktree", "investigate"], repo, env);
  assert.notEqual(readOnly.status, 0);
  assert.match(readOnly.stderr, /add --write/);

  const resumed = bridge(["run", "--write", "--worktree", "--resume-last", "continue"], repo, env);
  assert.notEqual(resumed.status, 0);
  assert.match(resumed.stderr, /cannot be combined with --resume/);
});

test("sync-skills wraps muse skills import", () => {
  const { repo, env } = setup();
  const dry = bridge(["sync-skills", "--dry-run", "--json"], repo, env);
  assert.equal(dry.status, 0, dry.stderr);
  const payload = JSON.parse(dry.stdout);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.candidates[0].name, "my-claude-skill");
  assert.deepEqual(payload.installed, []);

  const real = bridge(["sync-skills"], repo, env);
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /# Muse Code Skills Sync/);
  assert.match(real.stdout, /Installed:\n- my-claude-skill/);
});

test("run --resume-last continues the previous delegate session id", () => {
  const { repo, env, fakeLog } = setup();
  const first = bridge(["run", "--json", "first task"], repo, env);
  assert.equal(first.status, 0, first.stderr);
  const firstThread = JSON.parse(first.stdout).threadId;
  assert.ok(firstThread);

  const second = bridge(["run", "--json", "--resume-last", "what was the codeword?"], repo, env);
  assert.equal(second.status, 0, second.stderr);
  const payload = JSON.parse(second.stdout);
  assert.equal(payload.threadId, firstThread);
  assert.equal(payload.resumed, true);
  assert.match(payload.rawOutput, /ZEBRA-42/);
  const argv = lastExecArgv(fakeLog);
  assert.equal(argv[argv.indexOf("--session-id") + 1], firstThread);
});

test("run --resume-last without history fails clearly", () => {
  const { repo, env } = setup();
  const result = bridge(["run", "--resume-last", "continue"], repo, env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No previous Muse Code delegate session/);
});

test("run --stop-gate is read-only, untrusted, and excluded from resume candidates", () => {
  const { repo, env, fakeLog } = setup({ env: { MUSE_CC_SESSION_ID: "claude-session-gate" } });
  const gate = bridge(["run", "--json", "--stop-gate", "Run a stop-gate review of the previous Claude turn."], repo, env);
  assert.equal(gate.status, 0, gate.stderr);
  assert.match(JSON.parse(gate.stdout).rawOutput, /^ALLOW:/);
  const argv = lastExecArgv(fakeLog);
  assert.ok(argv.includes("--disable-write"));
  assert.ok(argv.includes("--disable-shell"));
  assert.ok(!argv.includes("--trust-workspace"));

  const candidate = bridge(["run-resume-candidate", "--json"], repo, env);
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, false);
});

test("run reports a failed muse terminal as a failed job", () => {
  const { repo, env } = setup({ scenario: "fail-terminal" });
  const result = bridge(["run", "--json", "do it"], repo, env);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.terminal, "failed");
  assert.match(payload.failureMessage, /fake outage/);
  withEnv({ CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA }, () => {
    assert.equal(listJobs(repo)[0].status, "failed");
  });
});

test("runs and show surface the latest finished run with a resume hint", () => {
  const { repo, env } = setup();
  const task = bridge(["run", "--json", "do a small thing"], repo, env);
  assert.equal(task.status, 0, task.stderr);
  const threadId = JSON.parse(task.stdout).threadId;

  const status = bridge(["runs", "--json"], repo, env);
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.ok(statusPayload.latestFinished);
  assert.equal(statusPayload.latestFinished.status, "completed");
  assert.equal(statusPayload.latestFinished.kindLabel, "delegate");

  const text = bridge(["runs"], repo, env);
  assert.match(text.stdout, /# Muse Code Runs/);
  assert.match(text.stdout, new RegExp(`muse resume ${threadId}`));

  const result = bridge(["show"], repo, env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
  assert.match(result.stdout, new RegExp(`Resume in Muse: muse resume ${threadId}`));

  const single = bridge(["runs", statusPayload.latestFinished.id], repo, env);
  assert.match(single.stdout, /# Muse Code Run Status/);
  assert.match(single.stdout, /Show: \/muse:show/);
});

test("run-resume-candidate reports available after a completed run in this Claude session", () => {
  const { repo, env } = setup({ env: { MUSE_CC_SESSION_ID: "claude-session-1" } });
  const task = bridge(["run", "first task"], repo, env);
  assert.equal(task.status, 0, task.stderr);

  const candidate = bridge(["run-resume-candidate", "--json"], repo, env);
  assert.equal(candidate.status, 0, candidate.stderr);
  const payload = JSON.parse(candidate.stdout);
  assert.equal(payload.available, true);
  assert.ok(payload.candidate?.threadId);

  const other = bridge(["run-resume-candidate", "--json"], repo, { ...env, MUSE_CC_SESSION_ID: "claude-session-2" });
  assert.equal(JSON.parse(other.stdout).available, false);
});

function processAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code !== "ESRCH";
  }
  if (process.platform === "win32") {
    return true;
  }
  const ps = run("ps", ["-p", String(pid), "-o", "stat="], { shell: false });
  const stat = String(ps.stdout ?? "").trim().toUpperCase();
  if (!stat || stat.includes("Z")) {
    return false;
  }
  return true;
}

test("stop terminates tracked sleeper processes and marks the run cancelled", () => {
  const { repo, env } = setup();
  const sleeper = () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
      cwd: repo,
      stdio: "ignore",
      detached: process.platform !== "win32"
    });
    child.unref();
    return child.pid;
  };
  const agentPid = sleeper();
  const bridgePid = sleeper();

  try {
    withEnv({ CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA }, () => {
      const jobId = generateJobId("run");
      const jobsDir = path.join(resolveStateDir(repo), "jobs");
      fs.mkdirSync(jobsDir, { recursive: true });
      const logFile = path.join(jobsDir, `${jobId}.log`);
      fs.writeFileSync(logFile, "", "utf8");
      const job = {
        id: jobId,
        kind: "task",
        kindLabel: "delegate",
        title: "Muse Code Delegate",
        workspaceRoot: repo,
        jobClass: "task",
        summary: "fake running",
        status: "running",
        phase: "running",
        bridgePid,
        pid: bridgePid,
        agentPid,
        logFile,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      writeJobFile(repo, jobId, job);
      upsertJob(repo, job);

      const result = bridge(["stop", jobId, "--json"], repo, env);
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.status, "cancelled");
      assert.equal(payload.jobId, jobId);
      assert.equal(payload.killDelivered, true);
      assert.ok(payload.killTargets?.includes(agentPid));
      assert.ok(payload.killTargets?.includes(bridgePid));

      const cancelled = listJobs(repo).find((entry) => entry.id === jobId);
      assert.equal(cancelled?.status, "cancelled");
    });

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && (processAlive(agentPid) || processAlive(bridgePid))) {
      // taskkill / SIGKILL may take a moment to be reflected
    }
    assert.equal(processAlive(agentPid), false);
    assert.equal(processAlive(bridgePid), false);
  } finally {
    for (const pid of [agentPid, bridgePid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
      }
    }
  }
});

test("enqueueBackgroundJob writes the job file before spawning the worker", async () => {
  const { enqueueBackgroundJob } = await import("../plugins/muse/scripts/muse-bridge.mjs");
  const repo = makeTempDir();
  const pluginDataDir = makeTempDir();

  withEnv({ CLAUDE_PLUGIN_DATA: pluginDataDir }, () => {
    const events = [];
    const job = {
      id: generateJobId("run"),
      kind: "task",
      kindLabel: "delegate",
      title: "Muse Code Delegate",
      workspaceRoot: repo,
      jobClass: "task",
      summary: "bg order",
      write: false
    };

    const result = enqueueBackgroundJob(
      repo,
      job,
      { kind: "task", cwd: repo, prompt: "hello", write: false, resumeLast: false, jobId: job.id },
      {
        spawnWorker(cwd, jobId) {
          events.push("spawn");
          const jobFile = path.join(resolveStateDir(repo), "jobs", `${jobId}.json`);
          const stored = fs.existsSync(jobFile) ? JSON.parse(fs.readFileSync(jobFile, "utf8")) : null;
          events.push(stored ? "job-present-at-spawn" : "job-missing-at-spawn");
          assert.ok(stored, "job file must exist before worker spawn");
          assert.equal(stored.status, "queued");
          assert.equal(stored.pid, null);
          return { pid: 424242 };
        }
      }
    );

    assert.deepEqual(events, ["spawn", "job-present-at-spawn"]);
    assert.equal(result.payload.status, "queued");
    assert.equal(result.payload.pid, 424242);
    assert.equal(result.payload.bridgePid, 424242);
    assert.equal(listJobs(repo)[0].pid, 424242);
  });
});

test("background run completes through the detached worker", async () => {
  const { repo, env } = setup();
  const queued = bridge(["run", "--json", "--background", "long task"], repo, env);
  assert.equal(queued.status, 0, queued.stderr);
  const jobId = JSON.parse(queued.stdout).jobId;
  assert.ok(jobId);

  const waited = bridge(["runs", jobId, "--json", "--wait", "--timeout-ms", "20000"], repo, env);
  assert.equal(waited.status, 0, waited.stderr);
  const payload = JSON.parse(waited.stdout);
  assert.equal(payload.job.status, "completed", JSON.stringify(payload.job));
  assert.equal(payload.waitTimedOut, false);

  const shown = bridge(["show", jobId], repo, env);
  assert.match(shown.stdout, /Handled the requested task/);
});

test("transfer uses Muse's native resume-claude import and prints the resume hint", () => {
  const { repo, env, home, fakeLog } = setup();
  const sessionPath = writeClaudeTranscript(home);

  const result = bridge(["transfer", "--source", sessionPath, "--json"], repo, env);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "native");
  assert.equal(payload.nativeFailure, null);
  assert.ok(payload.threadId);
  assert.equal(payload.resumeCommand, `muse resume ${payload.threadId}`);
  assert.equal(payload.turnCount, 3);
  assert.match(payload.summary, /native import/);

  const argv = lastExecArgv(fakeLog);
  assert.ok(argv.includes("--disable-write"));
  assert.ok(argv.includes("--disable-shell"));
  assert.ok(argv.includes("--trust-workspace"));
  assert.equal(argv[argv.indexOf("--max-model-steps") + 1], "24");

  const rendered = bridge(["transfer", "--source", sessionPath], repo, env);
  assert.match(rendered.stdout, /imported the transcript itself with its resume-claude skill/);
  assert.match(rendered.stdout, /Resume in Muse: muse resume/);
  assert.match(rendered.stdout, /Turns imported: 3/);
});

test("transfer falls back to a condensed transcript when the native import yields nothing", () => {
  const { repo, env, home } = setup({ scenario: "native-transfer-fails" });
  const sessionPath = writeClaudeTranscript(home);
  const result = bridge(["transfer", "--source", sessionPath, "--json"], repo, env);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "condensed");
  assert.ok(payload.nativeFailure);
  assert.match(payload.summary, /Handoff note: the user was building a widget/);

  const forced = bridge(["transfer", "--source", sessionPath, "--condensed", "--json"], repo, { ...env, MUSE_BINARY: env.MUSE_BINARY });
  assert.equal(JSON.parse(forced.stdout).mode, "condensed");
});

test("transfer forwards --model and --effort to the native import", () => {
  const { repo, env, home, fakeLog } = setup();
  const sessionPath = writeClaudeTranscript(home);
  const result = bridge(["transfer", "--source", sessionPath, "--model", "spark-1.2", "--effort", "high", "--json"], repo, env);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.doesNotMatch(result.stderr, /ignoring unknown option/);
  assert.equal(JSON.parse(result.stdout).mode, "native");
  const argvs = execArgvs(fakeLog);
  assert.equal(argvs.length, 1);
  assert.equal(argvs[0][argvs[0].indexOf("--model") + 1], "muse-spark-1.2");
  assert.equal(argvs[0][argvs[0].indexOf("--reasoning-effort") + 1], "high");
});

test("transfer forwards --model and --effort to the condensed fallback too", () => {
  const { repo, env, home, fakeLog } = setup({ scenario: "native-transfer-fails" });
  const sessionPath = writeClaudeTranscript(home);
  const result = bridge(["transfer", "--source", sessionPath, "--model", "contributor", "--effort", "medium", "--json"], repo, env);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(JSON.parse(result.stdout).mode, "condensed");
  const argvs = execArgvs(fakeLog);
  assert.equal(argvs.length, 2, "the native attempt, then the condensed fallback");
  for (const argv of argvs) {
    assert.equal(argv[argv.indexOf("--model") + 1], "muse-spark-1.3-contributor", argv.join(" "));
    assert.equal(argv[argv.indexOf("--reasoning-effort") + 1], "medium", argv.join(" "));
  }
});

test("transfer refuses transcripts outside ~/.claude/projects", () => {
  const { repo, env } = setup();
  const outside = path.join(makeTempDir(), "sess.jsonl");
  fs.writeFileSync(outside, '{"type":"user","message":{"role":"user","content":"hi"}}\n', "utf8");
  const result = bridge(["transfer", "--source", outside, "--json"], repo, env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only from/);
});

test("session lifecycle hook exports env vars on SessionStart", () => {
  const { repo, env } = setup();
  const envFile = path.join(makeTempDir(), "env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const hook = runNode([path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs"), "SessionStart"], {
    cwd: repo,
    env: { ...env, CLAUDE_ENV_FILE: envFile },
    input: JSON.stringify({ session_id: "sess-abc", transcript_path: "/tmp/t.jsonl", cwd: repo })
  });
  assert.equal(hook.status, 0, hook.stderr);
  const exported = fs.readFileSync(envFile, "utf8");
  assert.match(exported, /export MUSE_CC_SESSION_ID='sess-abc'/);
  assert.match(exported, /export MUSE_CC_TRANSCRIPT_PATH='\/tmp\/t\.jsonl'/);
});

test("stop-review gate hook allows when disabled and blocks on BLOCK output", () => {
  const { repo, env } = setup();
  const hookScript = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
  const input = JSON.stringify({ session_id: "s", cwd: repo, last_assistant_message: "Edited src.js" });

  const disabled = runNode([hookScript], { cwd: repo, env, input });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(disabled.stdout.trim(), "");

  bridge(["check", "--enable-review-gate"], repo, env);
  const allowed = runNode([hookScript], { cwd: repo, env, input });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "", "ALLOW output must not block");

  const recursive = runNode([hookScript], {
    cwd: repo,
    env,
    input: JSON.stringify({ session_id: "s", cwd: repo, stop_hook_active: true })
  });
  assert.equal(recursive.stdout.trim(), "");

  const failing = runNode([hookScript], { cwd: repo, env: { ...env, MUSE_BINARY: installFakeMuse(makeTempDir(), "fail-terminal") }, input });
  assert.equal(failing.status, 0, failing.stderr);
  const decision = JSON.parse(failing.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /failed/i);
});
