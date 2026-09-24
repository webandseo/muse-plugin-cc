import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeAuth, installFakeModelCatalog, installFakeMuse } from "./fake-muse-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import {
  buildMuseLaunch,
  buildReviewPrompt,
  consumeMuseEvent,
  createMuseEventState,
  getMuseAuthStatus,
  getMuseAvailability,
  assembleFinalMessage,
  mapDrivelessPathsToHost,
  stripExtendedPathPrefix,
  normalizeRequestedModel,
  parseStructuredOutput,
  parseWindowsSandboxCheck,
  readModelCatalog,
  resolveModelSelection,
  resolveMuseBinary,
  resolveMuseRuntime,
  resolveMuseShimExecutable,
  runHeadlessAgent
} from "../plugins/muse/scripts/lib/muse.mjs";

test("normalizeRequestedModel expands aliases and passes real ids through", () => {
  assert.equal(normalizeRequestedModel("spark"), "muse-spark-1.3");
  assert.equal(normalizeRequestedModel("Contributor"), "muse-spark-1.3-contributor");
  assert.equal(normalizeRequestedModel("muse-spark-1.2"), "muse-spark-1.2");
  assert.equal(normalizeRequestedModel("  "), null);
  assert.equal(normalizeRequestedModel(undefined), null);
});

test("resolveModelSelection prefers --model, then MUSE_CC_MODEL, then the spark default", () => {
  assert.deepEqual(resolveModelSelection("contributor", { MUSE_CC_MODEL: "spark-1.2" }), {
    model: "muse-spark-1.3-contributor",
    source: "flag",
    requested: "contributor"
  });
  assert.deepEqual(resolveModelSelection(null, { MUSE_CC_MODEL: "contributor" }), {
    model: "muse-spark-1.3-contributor",
    source: "env",
    requested: "contributor"
  });
  assert.deepEqual(resolveModelSelection(undefined, { MUSE_CC_MODEL: " muse-spark-9 " }), {
    model: "muse-spark-9",
    source: "env",
    requested: "muse-spark-9"
  });
  assert.deepEqual(resolveModelSelection("  ", { MUSE_CC_MODEL: " " }), {
    model: "muse-spark-1.3",
    source: "default",
    requested: "spark"
  });
  assert.equal(resolveModelSelection(null, {}).model, "muse-spark-1.3");
});

test("runHeadlessAgent always names a model so Muse's contributor default is never implied", async () => {
  const binDir = makeTempDir();
  const fake = installFakeMuse(binDir);
  const cwd = makeTempDir();
  const env = buildEnv(fake);
  delete env.MUSE_CC_MODEL;

  const byDefault = await runHeadlessAgent(cwd, { prompt: "check the thing", env });
  assert.equal(byDefault.args[byDefault.args.indexOf("--model") + 1], "muse-spark-1.3");

  const fromEnv = await runHeadlessAgent(cwd, { prompt: "check the thing", env: { ...env, MUSE_CC_MODEL: "contributor" } });
  assert.equal(fromEnv.args[fromEnv.args.indexOf("--model") + 1], "muse-spark-1.3-contributor");
});

test("readModelCatalog reads Muse's cached catalog and skips hidden rows", () => {
  const home = makeTempDir();
  installFakeModelCatalog(home);
  const env = { HOME: home, USERPROFILE: home };
  const rows = readModelCatalog({ env });
  assert.deepEqual(rows.map((row) => row.id), ["muse-spark-1.3", "muse-spark-1.3-contributor"]);
  assert.equal(rows.find((row) => row.isDefault).id, "muse-spark-1.3-contributor");
  assert.deepEqual(rows[1].efforts, ["low", "high"]);
  assert.deepEqual(readModelCatalog({ env: { HOME: makeTempDir() } }), []);
});

test("resolveMuseShimExecutable finds the pinned muse-bin exe beside a Windows shim", () => {
  const dir = makeTempDir();
  const shim = path.join(dir, "muse.cmd");
  fs.writeFileSync(shim, "@echo off\r\n", "utf8");
  assert.equal(resolveMuseShimExecutable(shim), null, "no exe yet");

  fs.writeFileSync(path.join(dir, "muse-bin-1.2.0.exe"), "", "utf8");
  fs.writeFileSync(path.join(dir, "muse-bin-1.3.0.exe"), "", "utf8");
  assert.equal(resolveMuseShimExecutable(shim), path.join(dir, "muse-bin-1.3.0.exe"), "newest by name without a pin");

  fs.writeFileSync(path.join(dir, ".muse-version"), "1.2.0\n", "utf8");
  assert.equal(resolveMuseShimExecutable(shim), path.join(dir, "muse-bin-1.2.0.exe"), "pinned by .muse-version");

  assert.equal(resolveMuseShimExecutable(path.join(dir, "muse")), null, "only shims are unwrapped");
});

test("resolveMuseBinary prefers MUSE_BINARY override", () => {
  assert.equal(resolveMuseBinary({ MUSE_BINARY: "/custom/muse" }), "/custom/muse");
  assert.equal(resolveMuseBinary({}), "muse");
});

test("resolveMuseRuntime uses the PATH name on POSIX hosts", () => {
  assert.equal(resolveMuseRuntime({ env: {}, platform: "linux" }).binary, "muse");
  assert.equal(resolveMuseRuntime({ env: { MUSE_BINARY: "/opt/muse" }, platform: "darwin" }).binary, "/opt/muse");
});

test("resolveMuseRuntime resolves a Windows shim to its exe", { skip: process.platform !== "win32" }, () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "muse.cmd"), "@echo off\r\n", "utf8");
  fs.writeFileSync(path.join(dir, ".muse-version"), "9.9.9\n", "utf8");
  fs.writeFileSync(path.join(dir, "muse-bin-9.9.9.exe"), "", "utf8");
  const env = { ...process.env, PATH: `${dir};${process.env.PATH ?? ""}` };
  delete env.MUSE_BINARY;
  const runtime = resolveMuseRuntime({ env, platform: "win32" });
  // where.exe returns the long-name path; the temp dir may be an 8.3 short name (RUNNER~1).
  assert.equal(
    fs.realpathSync.native(runtime.binary).toLowerCase(),
    fs.realpathSync.native(path.join(dir, "muse-bin-9.9.9.exe")).toLowerCase()
  );
  assert.match(runtime.reason, /shim/);
});

test("buildMuseLaunch runs script binaries through node", () => {
  const script = buildMuseLaunch({ binary: "/x/fake-muse.mjs", platform: "linux" }, "/repo", ["--version"], { env: {} });
  assert.equal(script.command, process.execPath);
  assert.deepEqual(script.args, ["/x/fake-muse.mjs", "--version"]);

  const plain = buildMuseLaunch({ binary: "muse", platform: "linux" }, "/repo", ["--version"], { env: {} });
  assert.equal(plain.command, "muse");
  assert.deepEqual(plain.args, ["--version"]);
});

test("getMuseAvailability reports the fake version", () => {
  const binDir = makeTempDir();
  const fake = installFakeMuse(binDir);
  const status = getMuseAvailability(process.cwd(), { env: buildEnv(fake) });
  assert.equal(status.available, true);
  assert.match(status.detail, /9\.9\.9-fake/);
});

test("getMuseAvailability reports unavailable for a missing binary", () => {
  const status = getMuseAvailability(process.cwd(), {
    env: { ...process.env, MUSE_BINARY: path.join(makeTempDir(), "missing-muse.mjs") }
  });
  assert.equal(status.available, false);
});

test("getMuseAuthStatus reads providers from auth.json", () => {
  const binDir = makeTempDir();
  const fake = installFakeMuse(binDir);
  const home = makeTempDir();
  installFakeAuth(home);
  const env = buildEnv(fake, { HOME: home, USERPROFILE: home, META_API_KEY: "", XDG_CONFIG_HOME: "" });
  delete env.XDG_CONFIG_HOME;
  delete env.META_API_KEY;

  const auth = getMuseAuthStatus(process.cwd(), { env, platform: "linux" });
  assert.equal(auth.loggedIn, true);
  assert.equal(auth.source, "auth-file");
  assert.match(auth.detail, /tests@example\.com/);
});

test("getMuseAuthStatus treats an empty provider list as logged out and META_API_KEY as logged in", () => {
  const binDir = makeTempDir();
  const fake = installFakeMuse(binDir);
  const home = makeTempDir();
  installFakeAuth(home, { loggedIn: false });
  const env = buildEnv(fake, { HOME: home, USERPROFILE: home });
  delete env.XDG_CONFIG_HOME;
  delete env.META_API_KEY;

  const loggedOut = getMuseAuthStatus(process.cwd(), { env, platform: "linux" });
  assert.equal(loggedOut.loggedIn, false);
  assert.match(loggedOut.detail, /muse login/);

  const viaKey = getMuseAuthStatus(process.cwd(), { env: { ...env, META_API_KEY: "sk-fake" }, platform: "linux" });
  assert.equal(viaKey.loggedIn, true);
  assert.equal(viaKey.authMethod, "api-key-env");
});

test("consumeMuseEvent tracks session id, model, phases, and terminal text", () => {
  const state = createMuseEventState();
  const events = [];
  const onProgress = (event) => events.push(typeof event === "string" ? { message: event } : event);
  const session = { kind: "session", id: "sess-1" };

  consumeMuseEvent({ stream: session, payload_type: "run.model.configured", payload: { model_id: "muse-spark-1.3" } }, state, onProgress);
  consumeMuseEvent(
    { stream: session, payload_type: "task.lifecycle.proposed", payload: { event: { task_kind: "tool.bash" } } },
    state,
    onProgress
  );
  consumeMuseEvent(
    { stream: session, payload_type: "task.lifecycle.proposed", payload: { event: { task_kind: "tool.write_file" } } },
    state,
    onProgress
  );
  consumeMuseEvent(
    { stream: session, payload_type: "task.lifecycle.proposed", payload: { event: { task_kind: "reminder.agent.skill-reminder" } } },
    state,
    onProgress
  );
  consumeMuseEvent(
    { stream: session, payload_type: "tool.result", payload: { text: JSON.stringify({ command: "npm test", exit_code: 0 }) } },
    state,
    onProgress
  );
  consumeMuseEvent({ stream: session, payload_type: "run.output.delta", payload: { text: "PO" } }, state, onProgress);
  consumeMuseEvent({ stream: session, payload_type: "run.output.delta", payload: { text: "NG" } }, state, onProgress);
  consumeMuseEvent(
    { stream: session, payload_type: "run.terminal.completed", payload: { terminal: "completed", text: "PONG" } },
    state,
    onProgress
  );

  assert.equal(state.sessionId, "sess-1");
  assert.equal(state.model, "muse-spark-1.3");
  assert.equal(state.terminal, "completed");
  assert.equal(state.finalText, "PONG");
  assert.equal(state.outputDeltas.join(""), "PONG");
  assert.equal(state.toolCalls, 2);
  const phases = events.map((event) => event.phase).filter(Boolean);
  assert.deepEqual(phases, ["investigating", "editing", "verifying"]);
  assert.ok(events.some((event) => /Command completed: npm test \(exit 0\)/.test(event.message)));
  assert.ok(!events.some((event) => /reminder/i.test(event.message)));
});

test("assembleFinalMessage keeps assistant messages separate across model turns", () => {
  const state = createMuseEventState();
  const session = { kind: "session", id: "s" };
  const feed = (type, payload) => consumeMuseEvent({ stream: session, payload_type: type, payload }, state, null);
  feed("task.lifecycle.proposed", { event: { task_kind: "model.meta.response" } });
  feed("run.output.delta", { text: "Fixed add" });
  feed("run.output.delta", { text: " in math.js." });
  feed("task.lifecycle.proposed", { event: { task_kind: "tool.bash" } });
  feed("task.lifecycle.proposed", { event: { task_kind: "model.meta.response" } });
  feed("task.lifecycle.proposed", { event: { task_kind: "model.meta.response" } });
  feed("run.output.delta", { text: "Verified with node." });
  feed("run.terminal.completed", { terminal: "completed", text: "Fixed add in math.js.Verified with node." });
  assert.equal(assembleFinalMessage(state), "Fixed add in math.js.\n\nVerified with node.");
  assert.equal(assembleFinalMessage(state, { lastMessageOnly: true }), "Verified with node.");

  const noDeltas = createMuseEventState();
  noDeltas.finalText = "only terminal\n";
  assert.equal(assembleFinalMessage(noDeltas), "only terminal");
});

test("runHeadlessAgent captures the final message and forwards read-only flags", async () => {
  const binDir = makeTempDir();
  const fake = installFakeMuse(binDir);
  const cwd = makeTempDir();
  const events = [];

  const result = await runHeadlessAgent(cwd, {
    prompt: "check the thing",
    env: buildEnv(fake),
    write: false,
    shell: false,
    webTools: false,
    onProgress: (event) => events.push(event)
  });

  assert.equal(result.status, 0);
  assert.equal(result.terminal, "completed");
  assert.match(result.finalMessage, /Handled the requested task/);
  assert.equal(result.model, "muse-spark-fake");
  assert.equal(typeof result.threadId, "string");
  assert.ok(result.threadId.length > 0);
  assert.ok(result.args.includes("exec"));
  assert.ok(result.args.includes("--json"));
  assert.ok(result.args.includes("--prompt-file"));
  assert.ok(result.args.includes("--disable-write"));
  assert.ok(result.args.includes("--disable-shell"));
  assert.ok(result.args.includes("--disable-web-tools"));
  assert.ok(result.args.includes("--disable-approval"));
  assert.ok(!result.args.includes("--trust-workspace"));
  assert.equal(result.args[result.args.indexOf("--session-id") + 1], result.threadId);
  assert.equal(typeof result.agentPid, "number");
  assert.ok(events.some((event) => event?.agentPid === result.agentPid));
  assert.ok(events.some((event) => /Session ready/.test(event?.message)));
});

test("runHeadlessAgent keeps foreign personal context out unless MUSE_CC_FOREIGN_CONTEXT=1", async () => {
  const binDir = makeTempDir();
  const fake = installFakeMuse(binDir);
  const cwd = makeTempDir();
  const env = buildEnv(fake);
  delete env.MUSE_CC_FOREIGN_CONTEXT;

  const isolated = await runHeadlessAgent(cwd, { prompt: "check the thing", env });
  assert.ok(isolated.args.includes("--no-foreign-personal-context"), isolated.args.join(" "));

  const optedOut = await runHeadlessAgent(cwd, { prompt: "check the thing", env: { ...env, MUSE_CC_FOREIGN_CONTEXT: "1" } });
  assert.ok(!optedOut.args.includes("--no-foreign-personal-context"), optedOut.args.join(" "));
});

test("runHeadlessAgent continues a given session id and passes schema, model, and effort", async () => {
  const binDir = makeTempDir();
  const fake = installFakeMuse(binDir);
  const cwd = makeTempDir();
  const log = path.join(binDir, "fake.log");

  const result = await runHeadlessAgent(cwd, {
    prompt: "what was the codeword?",
    env: buildEnv(fake, { FAKE_MUSE_LOG: log }),
    sessionId: "11111111-2222-4333-8444-555555555555",
    write: true,
    shell: true,
    trustWorkspace: true,
    model: "muse-spark-1.3",
    effort: "high",
    outputSchema: { type: "object" }
  });

  assert.equal(result.status, 0);
  assert.equal(result.threadId, "11111111-2222-4333-8444-555555555555");
  const argv = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").at(-1)).argv;
  assert.equal(argv[argv.indexOf("--session-id") + 1], "11111111-2222-4333-8444-555555555555");
  assert.equal(argv[argv.indexOf("--model") + 1], "muse-spark-1.3");
  assert.equal(argv[argv.indexOf("--reasoning-effort") + 1], "high");
  assert.ok(argv.includes("--output-schema"));
  assert.ok(argv.includes("--trust-workspace"));
  assert.ok(!argv.includes("--disable-write"));
  assert.ok(!argv.includes("--disable-shell"));
  // schema-driven runs return the JSON payload from the fake
  assert.match(result.finalMessage, /"verdict"/);
});

test("runHeadlessAgent maps a failed terminal record to a non-zero status with the reason", async () => {
  const binDir = makeTempDir();
  const fake = installFakeMuse(binDir, "fail-terminal");
  const cwd = makeTempDir();

  const result = await runHeadlessAgent(cwd, { prompt: "do it", env: buildEnv(fake) });
  assert.equal(result.status, 1);
  assert.equal(result.terminal, "failed");
  assert.match(result.failureDetail, /fake outage/);
});

test("runHeadlessAgent falls back to output deltas when no terminal record arrives", async () => {
  const binDir = makeTempDir();
  const fake = installFakeMuse(binDir, "no-terminal");
  const cwd = makeTempDir();

  const result = await runHeadlessAgent(cwd, { prompt: "do it", env: buildEnv(fake) });
  assert.equal(result.status, 0);
  assert.equal(result.terminal, null);
  assert.match(result.finalMessage, /Handled the requested task/);
});

test("runHeadlessAgent surfaces a process launch failure as a rejection or non-zero status", async () => {
  const binDir = makeTempDir();
  const fake = installFakeMuse(binDir, "fail-exec");
  const result = await runHeadlessAgent(makeTempDir(), { prompt: "do it", env: buildEnv(fake) });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /fake muse failed to start/);
});

test("parseStructuredOutput extracts fenced JSON and preserves fallback fields", () => {
  const raw = 'Here you go:\n```json\n{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}\n```\n';
  const parsed = parseStructuredOutput(raw, { status: 7 });
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "approve");
  assert.equal(parsed.status, 7);

  const missing = parseStructuredOutput("", { failureMessage: "boom" });
  assert.equal(missing.parsed, null);
  assert.equal(missing.parseError, "boom");
});

test("mapDrivelessPathsToHost restores the drive letter the Windows build drops", () => {
  assert.equal(
    mapDrivelessPathsToHost("see [math.js](/Users/Rich/repo/math.js:2)", "C:\\Users\\Rich\\repo"),
    "see [math.js](C:/Users/Rich/repo/math.js:2)"
  );
  assert.equal(mapDrivelessPathsToHost("nothing here", "C:\\Users\\Rich\\repo"), "nothing here");
  assert.equal(mapDrivelessPathsToHost("/tmp/x", "/tmp/repo"), "/tmp/x", "POSIX cwd is left alone");
});

test("stripExtendedPathPrefix removes \\\\?\\ prefixes", () => {
  assert.equal(stripExtendedPathPrefix("root: \\\\?\\C:\\Users\\Rich\\repo (cwd)"), "root: C:\\Users\\Rich\\repo (cwd)");
  assert.equal(stripExtendedPathPrefix("\\\\?\\UNC\\server\\share\\x"), "\\\\server\\share\\x");
  assert.equal(stripExtendedPathPrefix("plain"), "plain");
});

test("runHeadlessAgent passes an existing worktree through and reports it", async () => {
  const binDir = makeTempDir();
  const fake = installFakeMuse(binDir);
  const cwd = makeTempDir();
  const wt = path.join(cwd, ".muse", "worktrees", "given");
  const result = await runHeadlessAgent(cwd, {
    prompt: "work in the given worktree",
    env: buildEnv(fake),
    write: true,
    shell: true,
    worktreeExisting: wt
  });
  assert.equal(result.status, 0);
  assert.equal(result.args[result.args.indexOf("--worktree") + 1], "existing");
  assert.equal(result.args[result.args.indexOf("--worktree-existing") + 1], wt);
  assert.equal(result.worktreePath, wt);
});

test("parseWindowsSandboxCheck reads Muse's key=value report", () => {
  const notReady = parseWindowsSandboxCheck(
    "backend=windows_elevated\nstatus=setup_required\nreason=sandbox users are not ready\nrunner_trusted=true\ndiagnostic=sandbox_users_missing:required Windows sandbox users are missing or stale\nsandbox users are not ready\n",
    1
  );
  assert.equal(notReady.ready, false);
  assert.equal(notReady.status, "setup_required");
  assert.match(notReady.detail, /setup_required — sandbox users are not ready/);
  assert.equal(notReady.diagnostics.length, 1);

  const ready = parseWindowsSandboxCheck("backend=windows_elevated\nstatus=ready\n", 0);
  assert.equal(ready.ready, true);
  assert.match(ready.detail, /ready \(windows_elevated\)/);
});

test("buildReviewPrompt includes target, focus, and the no-shell rule", () => {
  const prompt = buildReviewPrompt({
    targetLabel: "working tree diff",
    focusText: "auth boundaries",
    collectionGuidance: "Use the repository context below as primary evidence.",
    reviewInput: "## Git Status\n M app.js"
  });
  assert.match(prompt, /working tree diff/);
  assert.match(prompt, /auth boundaries/);
  assert.match(prompt, /Git Status/);
  assert.match(prompt, /no shell/i);
});
