import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

/**
 * Install a fake `muse` that speaks the real `muse exec --json` JSONL dialect
 * (session stream id, run.model.configured, task.lifecycle.proposed,
 * run.output.delta, run.terminal.*) for hermetic tests.
 *
 * Returns the path of the fake script. Tests point MUSE_BINARY at it, which
 * the bridge runs through `process.execPath` on every platform. On POSIX a
 * `muse` shim is also written next to it for PATH-resolution tests.
 *
 * The fake never calls process.exit(): stdout is an async pipe on macOS and
 * Windows, and exiting hard can drop the final JSONL record. It sets
 * process.exitCode and lets the event loop drain instead.
 *
 * @param {string} binDir
 * @param {"default"|"fail-exec"|"fail-terminal"|"no-terminal"|"native-transfer-fails"} scenario
 */
export function installFakeMuse(binDir, scenario = "default") {
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, "fake-muse.mjs");

  const source = `#!/usr/bin/env node
import fs from "node:fs";

const scenario = ${JSON.stringify(scenario)};
const argv = process.argv.slice(2);

function hasFlag(name) {
  return argv.includes(name);
}

function flagValue(name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function writeLog() {
  const logPath = process.env.FAKE_MUSE_LOG;
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify({ argv, scenario, cwd: process.cwd() }) + "\\n");
}

function main() {
  writeLog();

  if (argv[0] === "--version" || argv[0] === "-V") {
    process.stdout.write("Muse Code 9.9.9-fake (9.9.9-fake)\\n");
    return 0;
  }

  if (argv[0] === "sandbox" && argv[1] === "windows" && argv[2] === "check") {
    if (process.env.FAKE_MUSE_SANDBOX === "setup_required") {
      process.stdout.write("backend=windows_elevated\\nstatus=setup_required\\nreason=sandbox users are not ready\\ndiagnostic=sandbox_users_missing:required Windows sandbox users are missing or stale\\n");
      return 1;
    }
    process.stdout.write("backend=windows_elevated\\nstatus=ready\\n");
    return 0;
  }

  if (argv[0] === "skills" && argv[1] === "import") {
    const dryRun = hasFlag("--dry-run");
    const skill = { name: "my-claude-skill", path: "/fake/home/.claude/skills/my-claude-skill" };
    process.stdout.write(JSON.stringify({
      dry_run: dryRun,
      source: { path: "/fake/home/.claude/skills", type: "claude" },
      candidates: [skill],
      installed: dryRun ? [] : [skill],
      skipped: [],
      failed: [],
      quarantined: []
    }) + "\\n");
    return 0;
  }

  if (argv[0] !== "exec") {
    process.stderr.write("fake muse: unknown invocation: " + argv.join(" ") + "\\n");
    return 1;
  }

  if (scenario === "fail-exec") {
    process.stderr.write("fake muse failed to start\\n");
    return 2;
  }

  // Keeps a run alive long enough for tests that race a second run against it.
  const delayMs = Number(process.env.FAKE_MUSE_EXEC_DELAY_MS) || 0;
  if (delayMs > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  }

  const sessionId = flagValue("--session-id") ?? "01a0b50a-0000-7000-8000-000000000000";
  const promptFile = flagValue("--prompt-file");
  const prompt = promptFile ? fs.readFileSync(promptFile, "utf8") : (argv.find((a, i) => i > 0 && !a.startsWith("-")) ?? "");
  let sequence = 0;
  const emit = (payloadType, payload, recordType = "event") => {
    sequence += 1;
    process.stdout.write(JSON.stringify({
      schema_version: 1,
      id: "018f0000-0000-7000-8000-" + String(sequence).padStart(12, "0"),
      stream: { kind: "session", id: sessionId },
      sequence,
      recorded_at: 1780531400000000 + sequence,
      record_type: recordType,
      durability: "durable",
      causation_id: "cmd-1",
      payload_type: payloadType,
      payload_schema_version: 1,
      payload
    }) + "\\n");
  };

  const worktreeDir = flagValue("--worktree") === "existing" ? flagValue("--worktree-existing") : null;
  process.stderr.write("muse: workspace root: " + (worktreeDir ?? process.cwd()) + " (cwd default)\\n");
  emit("runtime.command.accepted", { kind: "command_accepted", command_kind: "turn.submit" }, "reconciliation");
  emit("run.model.configured", { kind: "run_model_configured", model_id: "muse-spark-fake", provider_id: "meta" });
  emit("run.lifecycle.started", { kind: "run_started", prompt });
  emit("task.lifecycle.proposed", { kind: "task_lifecycle", event: { kind: "proposed", task_kind: "model.meta.response" } });
  emit("task.lifecycle.status", { kind: "task_lifecycle", event: { kind: "status", message: "opening meta model stream attempt 1/10" } });
  emit("task.lifecycle.proposed", { kind: "task_lifecycle", event: { kind: "proposed", task_kind: "tool.read_file" } });
  if (!hasFlag("--disable-shell")) {
    emit("task.lifecycle.proposed", { kind: "task_lifecycle", event: { kind: "proposed", task_kind: "tool.bash" } });
    emit("tool.result", { text: JSON.stringify({ command: "npm test", exit_code: 0, output: "ok" }) });
  }
  if (!hasFlag("--disable-write")) {
    emit("task.lifecycle.proposed", { kind: "task_lifecycle", event: { kind: "proposed", task_kind: "tool.write_file" } });
  }

  if (scenario === "fail-terminal") {
    emit("task.lifecycle.failed", { kind: "task_lifecycle", event: { kind: "failed", reason: "model failed: fake outage" } });
    emit("run.terminal.failed", { kind: "run_terminal", terminal: "failed", reason: "model failed: fake outage", text: null });
    return 0;
  }

  let text;
  if (hasFlag("--output-schema") || /Return only valid JSON|critique/i.test(prompt)) {
    text = JSON.stringify({
      verdict: "approve",
      summary: "No material issues found in the reviewed changes.",
      findings: [],
      next_steps: ["Ship it."]
    });
  } else if (/stop-gate review|ALLOW:|BLOCK:/i.test(prompt)) {
    text = "ALLOW: previous turn did not make code changes";
  } else if (/bundled:resume-claude/i.test(prompt)) {
    text = scenario === "native-transfer-fails"
      ? ""
      : "Handoff note (native import): the user was building a widget; next step is to run the tests.";
  } else if (/handed a conversation that started in Claude Code/i.test(prompt)) {
    text = "Handoff note: the user was building a widget; next step is to run the tests.";
  } else if (/code review|Review the provided repository|Reviewing/i.test(prompt)) {
    text = "Reviewed uncommitted changes.\\nNo material issues found.";
  } else if (/what was the codeword/i.test(prompt)) {
    text = "ZEBRA-42";
  } else {
    text = "Handled the requested task.";
  }

  if (scenario === "no-terminal") {
    emit("run.output.delta", { kind: "run_output_delta", text }, "status");
    return 0;
  }

  emit("run.output.delta", { kind: "run_output_delta", text: text.slice(0, 4) }, "status");
  emit("run.output.delta", { kind: "run_output_delta", text: text.slice(4) }, "status");
  emit("run.terminal.completed", { kind: "run_terminal", terminal: "completed", reason: null, text });
  if (worktreeDir) {
    process.stderr.write("muse: session worktree retained at " + worktreeDir + " (caller-owned worktree retained)\\n");
  }
  return 0;
}

process.exitCode = main();
`;

  writeExecutable(scriptPath, source);

  if (process.platform !== "win32") {
    const shim = path.join(binDir, "muse");
    writeExecutable(shim, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
  }

  return scriptPath;
}

export function installFakeAuth(home, options = {}) {
  const dir = path.join(home, ".config", "muse");
  fs.mkdirSync(dir, { recursive: true });
  const loggedIn = options.loggedIn !== false;
  const payload = {
    schema_version: 1,
    providers: loggedIn
      ? [
          {
            key: "meta",
            mechanism: "login",
            access_token: "fake-token",
            user_email: "tests@example.com"
          }
        ]
      : []
  };
  fs.writeFileSync(path.join(dir, "auth.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path.join(dir, "auth.json");
}

/** Write a Muse model catalog file the way Muse caches it under ~/.local/share. */
export function installFakeModelCatalog(home, options = {}) {
  const dir = path.join(home, ".local", "share", "muse", "model-catalog");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "6d657461__fake.json");
  const rows = options.rows ?? [
    { model_id: "muse-spark-1.3", provider_id: "meta", visibility: "visible", is_default: false, description: null },
    {
      model_id: "muse-spark-1.3-contributor",
      provider_id: "meta",
      visibility: "visible",
      is_default: true,
      description: "Your content may be used for product improvement.",
      reasoning_effort_variants: [{ tier: "low" }, { tier: "high" }]
    },
    { model_id: "muse-spark-secret", provider_id: "meta", visibility: "hidden", is_default: false }
  ];
  fs.writeFileSync(file, `${JSON.stringify({ schema_version: 1, provider_id: "meta", rows }, null, 2)}\n`, "utf8");
  return file;
}

export function buildEnv(fakeMusePath, extra = {}) {
  return {
    ...process.env,
    MUSE_BINARY: fakeMusePath,
    ...extra
  };
}
