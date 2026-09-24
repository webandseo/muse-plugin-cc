import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

import { createTempDir, readJsonFile, removeDirQuietly } from "./fs.mjs";
import { runCommand } from "./process.mjs";

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";

export const VALID_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

const DEFAULT_BINARY = "muse";
export const BINARY_ENV = "MUSE_BINARY";
export const API_KEY_ENV = "META_API_KEY";

// Short names for the models in Muse's catalog. `contributor` is Meta's
// default and its catalog entry says content "may be used for product
// improvement"; `spark` is the same model without that.
export const MODEL_ALIASES = new Map([
  ["spark", "muse-spark-1.3"],
  ["spark-1.3", "muse-spark-1.3"],
  ["contributor", "muse-spark-1.3-contributor"],
  ["spark-1.2", "muse-spark-1.2"]
]);

export function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function parseModelCatalog(files) {
  const rows = [];
  for (const raw of files) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const row of parsed?.rows ?? []) {
      if (!row?.model_id || row.visibility === "hidden") {
        continue;
      }
      rows.push({
        id: row.model_id,
        provider: row.provider_id ?? parsed.provider_id ?? null,
        isDefault: Boolean(row.is_default),
        description: row.description ?? null,
        efforts: Array.isArray(row.reasoning_effort_variants)
          ? row.reasoning_effort_variants.map((entry) => entry?.tier).filter(Boolean)
          : []
      });
    }
  }
  return rows;
}

/** Models Muse has cached from its provider catalog (empty until Muse has run once). */
export function readModelCatalog(options = {}) {
  const env = options.env ?? process.env;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const dir = path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "muse", "model-catalog");
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    try {
      files.push(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
    }
  }
  return parseModelCatalog(files);
}

export function resolveMuseBinary(env = process.env) {
  const override = env?.[BINARY_ENV];
  if (override && String(override).trim()) {
    return String(override).trim();
  }
  return DEFAULT_BINARY;
}

function isScriptBinary(binary) {
  return /\.(mjs|cjs|js)$/i.test(String(binary));
}

function resolveWindowsExecutable(binary, env) {
  if (path.isAbsolute(binary)) {
    return fs.existsSync(binary) ? binary : null;
  }
  const result = runCommand("where.exe", [binary], { env, shell: false });
  if (result.error || result.status !== 0) {
    return null;
  }
  const first = String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first ?? null;
}

/**
 * Meta's Windows installer (`irm https://dev.meta.ai/install.ps1 | iex`)
 * puts a batch shim next to a PowerShell launcher, `.muse-version`, and the
 * real `muse-bin-<version>.exe`. Running the shim means cmd.exe → powershell
 * → exe with three rounds of argument re-parsing, so when the shim is what
 * PATH resolves to, prefer the binary beside it.
 */
export function resolveMuseShimExecutable(shimPath) {
  if (!/\.(cmd|bat)$/i.test(String(shimPath ?? ""))) {
    return null;
  }
  const dir = path.dirname(shimPath);
  try {
    const version = fs.readFileSync(path.join(dir, ".muse-version"), "utf8").trim();
    if (version) {
      const pinned = path.join(dir, `muse-bin-${version}.exe`);
      if (fs.existsSync(pinned)) {
        return pinned;
      }
    }
  } catch {
  }
  try {
    const candidates = fs
      .readdirSync(dir)
      .filter((name) => /^muse-bin-.+\.exe$/i.test(name))
      .sort();
    if (candidates.length > 0) {
      return path.join(dir, candidates[candidates.length - 1]);
    }
  } catch {
  }
  return null;
}

/**
 * Work out which executable to spawn for `muse`. On POSIX that is the name
 * on PATH (or MUSE_BINARY). On Windows, Node's spawn does not consult PATHEXT,
 * so resolve `muse.cmd` through where.exe and prefer the exe beside the shim.
 */
export function resolveMuseRuntime(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const binary = options.binary ?? resolveMuseBinary(env);

  if (platform !== "win32" || isScriptBinary(binary)) {
    return { binary, platform, reason: platform === "win32" ? "script binary" : "on PATH" };
  }

  const native = resolveWindowsExecutable(binary, env);
  if (native) {
    const exe = resolveMuseShimExecutable(native);
    return {
      binary: exe ?? native,
      platform,
      reason: exe ? `${path.basename(native)} shim, running ${path.basename(exe)} directly` : "found on PATH"
    };
  }

  return { binary, platform, reason: "not found on PATH" };
}

export function describeRuntime(runtime) {
  return runtime.reason && runtime.reason !== "on PATH" ? `${runtime.binary} (${runtime.reason})` : runtime.binary;
}

function quoteForCmd(value) {
  const text = String(value);
  if (!/[\s"&|<>^()]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Build the concrete process launch for a muse invocation in `cwd`.
 * Returns { command, args, spawnOptions } for spawn/spawnSync.
 */
export function buildMuseLaunch(runtime, cwd, museArgs = [], options = {}) {
  const env = options.env ?? process.env;
  const binary = runtime.binary;
  if (isScriptBinary(binary)) {
    return {
      command: process.execPath,
      args: [binary, ...museArgs],
      spawnOptions: { cwd, env, shell: false, windowsHide: true }
    };
  }

  if (runtime.platform === "win32" && /\.(cmd|bat)$/i.test(binary)) {
    // cmd.exe shims need cmd.exe; quote every token ourselves so paths with
    // spaces survive without handing argv to a shell for re-parsing.
    const commandLine = [binary, ...museArgs].map(quoteForCmd).join(" ");
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${commandLine}"`],
      spawnOptions: { cwd, env, shell: false, windowsHide: true, windowsVerbatimArguments: true }
    };
  }

  return {
    command: binary,
    args: museArgs,
    spawnOptions: { cwd, env, shell: false, windowsHide: true }
  };
}

export function runMuse(args = [], options = {}) {
  const env = options.env ?? process.env;
  const runtime = options.runtime ?? resolveMuseRuntime({ env, binary: options.binary });
  const cwd = options.cwd ?? process.cwd();
  const launch = buildMuseLaunch(runtime, cwd, args, { env });
  const result = runCommand(launch.command, launch.args, {
    cwd,
    env,
    input: options.input,
    maxBuffer: options.maxBuffer,
    shell: launch.spawnOptions.shell,
    spawnSyncImpl: options.spawnSyncImpl
  });
  return { ...result, runtime, launch };
}

function firstLine(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

export function getMuseAvailability(cwd, options = {}) {
  const env = options.env ?? process.env;
  const runtime = options.runtime ?? resolveMuseRuntime({ env, binary: options.binary });
  const result = runMuse(["--version"], { cwd: os.tmpdir(), env, runtime });
  const combined = `${result.stdout}\n${result.stderr}`.replace(/\0/g, "");

  if (result.error?.code === "ENOENT") {
    return { available: false, detail: `${runtime.binary} not found`, binary: runtime.binary, runtime };
  }
  if (result.error) {
    return { available: false, detail: result.error.message, binary: runtime.binary, runtime };
  }
  if (result.status !== 0) {
    const detail = firstLine(combined.trim()) || `exit ${result.status}`;
    return { available: false, detail, binary: runtime.binary, runtime };
  }
  const version = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /muse/i.test(line) || /^\d+\.\d+/.test(line));
  return {
    available: true,
    detail: version || firstLine(combined) || "ok",
    binary: runtime.binary,
    runtime
  };
}

function authFileCandidates(env = process.env, platform = process.platform) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const candidates = [];
  // The muse binary reads $XDG_CONFIG_HOME/muse/auth.json or
  // ~/.config/muse/auth.json, on Windows too.
  if (env.XDG_CONFIG_HOME) {
    candidates.push(path.join(env.XDG_CONFIG_HOME, "muse", "auth.json"));
  }
  candidates.push(path.join(home, ".config", "muse", "auth.json"));
  if (platform === "darwin") {
    candidates.push(path.join(home, "Library", "Application Support", "muse", "auth.json"));
  }
  return candidates;
}

function readAuthFile(env, platform) {
  for (const candidate of authFileCandidates(env, platform)) {
    try {
      if (fs.existsSync(candidate)) {
        return { path: candidate, raw: fs.readFileSync(candidate, "utf8") };
      }
    } catch {
    }
  }
  return null;
}

function summarizeAuthProviders(parsed) {
  const providers = parsed?.providers;
  const entries = Array.isArray(providers)
    ? providers
    : providers && typeof providers === "object"
      ? Object.entries(providers).map(([key, value]) => ({ key, ...(value ?? {}) }))
      : [];
  const authenticated = entries.filter((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    return Boolean(String(entry.api_key ?? "").trim() || String(entry.access_token ?? "").trim());
  });
  return {
    providers: entries.map((entry) => entry?.key ?? entry?.provider ?? "unknown"),
    authenticated: authenticated.map((entry) => ({
      key: entry.key ?? entry.provider ?? "unknown",
      mechanism: entry.mechanism ?? (entry.api_key ? "api-key" : "login"),
      user: entry.user_email ?? entry.user_full_name ?? null
    }))
  };
}

export function getMuseAuthStatus(cwd, options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const availability = options.availability ?? getMuseAvailability(cwd, options);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null
    };
  }

  if (String(env[API_KEY_ENV] ?? "").trim()) {
    return {
      available: true,
      loggedIn: true,
      detail: `${API_KEY_ENV} is set (takes priority over account login)`,
      source: "env",
      authMethod: "api-key-env",
      verified: null
    };
  }

  const file = readAuthFile(env, platform);
  if (!file) {
    return {
      available: true,
      loggedIn: false,
      detail: "no Muse credentials found (run `muse login`, or set META_API_KEY)",
      source: "auth-file",
      authMethod: null,
      verified: null
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(file.raw);
  } catch {
    return {
      available: true,
      loggedIn: false,
      detail: `could not parse ${file.path}`,
      source: "auth-file",
      authMethod: null,
      verified: null
    };
  }

  const summary = summarizeAuthProviders(parsed);
  if (summary.authenticated.length === 0) {
    return {
      available: true,
      loggedIn: false,
      detail: `no authenticated provider in ${file.path} (run \`muse login\`)`,
      source: "auth-file",
      authMethod: null,
      verified: null,
      providers: summary.providers
    };
  }

  const primary = summary.authenticated[0];
  return {
    available: true,
    loggedIn: true,
    detail: `logged in to ${primary.key}${primary.user ? ` as ${primary.user}` : ""} (${primary.mechanism})`,
    source: "auth-file",
    authMethod: primary.mechanism,
    verified: null,
    providers: summary.providers,
    authFile: file.path
  };
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function shorten(text, limit = 140) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function classifyTaskKind(taskKind) {
  const kind = String(taskKind ?? "");
  if (/^reminder\./.test(kind)) {
    return null;
  }
  if (/^model\./.test(kind)) {
    return { message: "Thinking.", phase: "thinking" };
  }
  if (/^tool\.(bash|shell|exec|run_command|command)/.test(kind)) {
    return { message: "Running shell command.", phase: "investigating" };
  }
  if (/^tool\.(write_file|edit_file|apply_patch|patch|create_file|delete_file|move_file|rename)/.test(kind)) {
    return { message: "Applying edits.", phase: "editing" };
  }
  if (/^tool\.(read_file|grep|glob|list_dir|ls|search|find|web_fetch|web_search)/.test(kind)) {
    return { message: "Reading files.", phase: "investigating" };
  }
  if (/^subagent\./.test(kind)) {
    return { message: `Subagent activity: ${kind}.`, phase: "investigating" };
  }
  if (/^tool\./.test(kind)) {
    return { message: `Running tool: ${kind.slice(5)}.`, phase: "investigating" };
  }
  return null;
}

function describeToolResult(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.command === "string") {
      const exit = parsed.exit_code ?? parsed.exitCode;
      const message = `Command completed: ${shorten(parsed.command, 120)}${exit != null ? ` (exit ${exit})` : ""}`;
      return { message, phase: looksLikeVerificationCommand(parsed.command) ? "verifying" : null };
    }
  } catch {
  }
  return { message: `Tool result: ${shorten(raw, 120)}`, phase: null };
}

/**
 * Consume one `muse exec --json` JSONL record. Mutates `state` and emits
 * progress events. Returns nothing; the caller reads `state` at close.
 */
export function consumeMuseEvent(record, state, onProgress) {
  if (!record || typeof record !== "object") {
    return;
  }
  if (record.stream?.kind === "session" && record.stream.id && !state.sessionId) {
    state.sessionId = record.stream.id;
    emitProgress(onProgress, `Session ready: ${state.sessionId}.`, null, { threadId: state.sessionId });
  }
  const payloadType = String(record.payload_type ?? "");
  const payload = record.payload ?? {};
  const event = payload.event ?? {};

  switch (payloadType) {
    case "run.model.configured":
      state.model = payload.model_id ?? payload.display_label ?? state.model;
      emitProgress(onProgress, `Model: ${state.model}.`, null);
      return;
    case "run.output.delta":
      if (typeof payload.text === "string") {
        state.outputDeltas.push(payload.text);
        state.segments[state.segments.length - 1].push(payload.text);
      }
      return;
    case "run.terminal.completed":
    case "run.terminal.failed":
    case "run.terminal.cancelled": {
      state.terminal = payload.terminal ?? payloadType.split(".").pop();
      state.terminalReason = payload.reason ?? null;
      if (typeof payload.text === "string" && payload.text.trim()) {
        state.finalText = payload.text;
      }
      return;
    }
    case "task.lifecycle.proposed": {
      const kind = String(event.task_kind ?? "");
      // Each model response is one assistant message. Muse's terminal text
      // concatenates them all, so keep message boundaries ourselves.
      if (/^model\./.test(kind) && state.segments[state.segments.length - 1].length > 0) {
        state.segments.push([]);
      }
      const classified = classifyTaskKind(kind);
      if (classified) {
        state.toolCalls += /^tool\./.test(kind) ? 1 : 0;
        emitProgress(onProgress, classified.message, classified.phase);
      }
      return;
    }
    case "task.lifecycle.status":
      if (event.message) {
        emitProgress(onProgress, shorten(event.message), null);
      }
      return;
    case "task.lifecycle.failed":
      if (event.reason) {
        state.taskFailures.push(String(event.reason));
        emitProgress(onProgress, `Task failed: ${shorten(event.reason)}`, null);
      }
      return;
    case "task.lifecycle.timed_out":
      state.taskFailures.push("task timed out");
      emitProgress(onProgress, "Task timed out.", null);
      return;
    case "tool.result": {
      const described = describeToolResult(payload.text);
      if (described) {
        emitProgress(onProgress, described.message, described.phase);
      }
      return;
    }
    default:
      return;
  }
}

/**
 * The run's answer: assistant messages joined by blank lines, from the delta
 * stream when there was one, otherwise the terminal record's text.
 */
export function assembleFinalMessage(state, options = {}) {
  const messages = state.segments.map((segment) => segment.join("").trim()).filter(Boolean);
  if (messages.length > 0) {
    // A review is one deliverable; when Muse retried mid-run (for example after
    // a stream idle timeout) it writes the whole thing again, so keep the last.
    return options.lastMessageOnly ? messages[messages.length - 1] : messages.join("\n\n");
  }
  return String(state.finalText ?? "").trimEnd();
}

export function createMuseEventState() {
  return {
    sessionId: null,
    model: null,
    terminal: null,
    terminalReason: null,
    finalText: null,
    segments: [[]],
    outputDeltas: [],
    taskFailures: [],
    toolCalls: 0,
    nonJsonLines: []
  };
}

/**
 * The native Windows build sometimes prints workspace paths without the drive
 * (`/Users/Rich/repo/x.js`). Restore the drive so file links resolve.
 */
export function mapDrivelessPathsToHost(text, hostCwd) {
  const hostForward = String(hostCwd ?? "").replace(/\\/g, "/");
  const match = hostForward.match(/^[A-Za-z]:(\/.+)$/);
  if (!text || !match || match[1].length < 4) {
    return text;
  }
  return String(text).split(match[1]).join(hostForward);
}

/** Strip the `\\?\` extended-length prefix the Windows build puts on paths. */
export function stripExtendedPathPrefix(text) {
  if (!text) {
    return text;
  }
  return String(text).replace(/\\\\\?\\(UNC\\)?/g, (match, unc) => (unc ? "\\\\" : ""));
}

function normalizeWindowsText(text, hostCwd) {
  return mapDrivelessPathsToHost(stripExtendedPathPrefix(text), hostCwd);
}

export const FOREIGN_CONTEXT_ENV = "MUSE_CC_FOREIGN_CONTEXT";

function buildExecArgs(options, paths) {
  const args = ["exec", "--json", "--prompt-file", paths.promptFile, "--session-id", options.sessionId];
  // Headless runs have no user to click Approve, so approval prompts must be
  // off. The read-only flags below are the actual safety boundary.
  args.push("--disable-approval", "--user-input-auto-resolve");
  // Otherwise Muse loads the user's own Claude Code skills and personal rules
  // (~/.claude) into every run the bridge makes and sends them with the prompt.
  if (!options.foreignContext) {
    args.push("--no-foreign-personal-context");
  }
  if (!options.write) {
    args.push("--disable-write");
  }
  if (!options.shell) {
    args.push("--disable-shell");
  }
  if (options.trustWorkspace) {
    args.push("--trust-workspace");
  }
  if (options.webTools === false) {
    args.push("--disable-web-tools");
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.effort) {
    args.push("--reasoning-effort", options.effort);
  }
  if (paths.schemaFile) {
    args.push("--output-schema", paths.schemaFile);
  }
  for (const image of paths.imageFiles ?? []) {
    args.push("--image", image);
  }
  if (options.worktreeExisting) {
    // The bridge creates the worktree with git and hands it over; Muse keeps
    // it at exit ("caller-owned worktree retained").
    args.push("--worktree", "existing", "--worktree-existing", options.worktreeExisting);
  }
  if (options.disableSandbox) {
    args.push("--disable-sandbox");
  }
  if (Number.isFinite(Number(options.maxModelSteps)) && Number(options.maxModelSteps) > 0) {
    args.push("--max-model-steps", String(Math.floor(Number(options.maxModelSteps))));
  }
  if (options.noSessionLog) {
    args.push("--no-session-log");
  }
  for (const extra of options.extraArgs ?? []) {
    args.push(extra);
  }
  return args;
}

/**
 * Run one headless Muse turn (`muse exec --json`) in `cwd` and collect the
 * final answer. Pass `sessionId` to continue an earlier headless session.
 */
export function runHeadlessAgent(cwd, options = {}) {
  const env = options.env ?? process.env;
  const prompt = String(options.prompt ?? "").trim() || options.defaultPrompt || "";
  if (!prompt) {
    return Promise.reject(new Error("A prompt is required for this Muse run."));
  }

  const runtime = options.runtime ?? resolveMuseRuntime({ env, binary: options.binary });
  const sessionId = options.sessionId || crypto.randomUUID();
  const tempDir = createTempDir("muse-cc-run-");
  const promptFile = path.join(tempDir, "prompt.md");
  fs.writeFileSync(promptFile, prompt.endsWith("\n") ? prompt : `${prompt}\n`, "utf8");
  let schemaFile = null;
  if (options.outputSchema) {
    schemaFile = path.join(tempDir, "output-schema.json");
    const schemaText =
      typeof options.outputSchema === "string" ? options.outputSchema : JSON.stringify(options.outputSchema, null, 2);
    fs.writeFileSync(schemaFile, `${schemaText}\n`, "utf8");
  }

  const imageFiles = (options.images ?? [])
    .map((image) => String(image ?? "").trim())
    .filter(Boolean)
    .map((image) => {
      const absolute = path.isAbsolute(image) ? image : path.resolve(cwd, image);
      if (!fs.existsSync(absolute)) {
        throw new Error(`Image not found: ${absolute}`);
      }
      return absolute;
    });
  const args = buildExecArgs(
    {
      ...options,
      sessionId,
      foreignContext: options.foreignContext ?? env[FOREIGN_CONTEXT_ENV] === "1"
    },
    { promptFile, schemaFile, imageFiles }
  );
  const launch = buildMuseLaunch(runtime, cwd, args, { env });
  const mapBack = (text) => (runtime.platform === "win32" ? normalizeWindowsText(text, cwd) : text);

  const platform = options.platform ?? process.platform;
  const detached = options.detached ?? platform !== "win32";

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(launch.command, launch.args, {
        ...launch.spawnOptions,
        stdio: ["ignore", "pipe", "pipe"],
        detached
      });
    } catch (error) {
      removeDirQuietly(tempDir);
      reject(error);
      return;
    }

    const agentPid = child.pid ?? null;
    const state = createMuseEventState();
    state.sessionId = null;
    emitProgress(
      options.onProgress,
      `Running muse exec (${runtime.binary}) as session ${sessionId}.`,
      "starting",
      { threadId: sessionId, agentPid, pid: agentPid }
    );

    let stdout = "";
    let stderr = "";
    let pending = "";

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      if (trimmed.startsWith("{")) {
        try {
          consumeMuseEvent(JSON.parse(trimmed), state, options.onProgress);
          return;
        } catch {
        }
      }
      state.nonJsonLines.push(trimmed);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        handleLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).replace(/\0/g, "");
      stderr += text;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("muse: ")) {
          emitProgress(options.onProgress, mapBack(trimmed.slice(6)), null);
        }
      }
    });

    child.on("error", (error) => {
      removeDirQuietly(tempDir);
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (pending.trim()) {
        handleLine(pending);
        pending = "";
      }
      removeDirQuietly(tempDir);

      let status = code ?? (signal ? 1 : 0);
      if (status === 0 && state.terminal === "failed") {
        status = 1;
      } else if (status === 0 && state.terminal === "cancelled") {
        status = 130;
      }

      const finalMessage = mapBack(assembleFinalMessage(state, { lastMessageOnly: Boolean(options.lastMessageOnly) }));
      const failureDetail =
        state.terminalReason ||
        (state.taskFailures.length ? state.taskFailures[state.taskFailures.length - 1] : "") ||
        firstLine(stderr.trim()) ||
        "";

      emitProgress(
        options.onProgress,
        status === 0
          ? "Muse finished."
          : state.terminal === "cancelled"
            ? "Muse run cancelled."
            : `Muse run failed${failureDetail ? `: ${shorten(failureDetail)}` : ` (exit ${status})`}.`,
        status === 0 ? "finalizing" : state.terminal === "cancelled" ? "cancelled" : "failed",
        { threadId: state.sessionId ?? sessionId, agentPid }
      );

      resolve({
        status,
        signal,
        stdout,
        stderr,
        sessionId: state.sessionId ?? sessionId,
        threadId: state.sessionId ?? sessionId,
        agentPid,
        finalMessage,
        terminalText: state.finalText,
        terminal: state.terminal,
        terminalReason: state.terminalReason,
        failureDetail,
        model: state.model,
        toolCalls: state.toolCalls,
        taskFailures: state.taskFailures,
        worktreePath: options.worktreeExisting ?? null,
        args,
        launch,
        runtime,
        binary: runtime.binary
      });
    });
  });
}

export const DISABLE_SANDBOX_ENV = "MUSE_CC_DISABLE_SANDBOX";

/** Parse the key=value lines of `muse sandbox windows check`. */
export function parseWindowsSandboxCheck(text, exitCode = null) {
  const fields = {};
  const diagnostics = [];
  for (const line of String(text ?? "").replace(/\0/g, "").split(/\r?\n/)) {
    const match = line.match(/^([a-z_]+)=(.*)$/i);
    if (!match) {
      continue;
    }
    if (match[1] === "diagnostic") {
      diagnostics.push(match[2].trim());
    } else {
      fields[match[1]] = match[2].trim();
    }
  }
  const status = fields.status ?? (exitCode === 0 ? "ready" : "unknown");
  const ready = status === "ready" || (exitCode === 0 && !fields.status);
  return {
    checked: true,
    ready,
    status,
    reason: fields.reason ?? null,
    backend: fields.backend ?? null,
    diagnostics,
    detail: ready ? `ready${fields.backend ? ` (${fields.backend})` : ""}` : `${status}${fields.reason ? ` — ${fields.reason}` : ""}`
  };
}

/**
 * The native Windows build runs shell commands inside an OS sandbox that needs
 * a one-time elevated setup (`muse sandbox windows setup`). Reviews never use
 * the shell, but write-capable delegate runs do.
 */
export function getWindowsSandboxStatus(cwd, options = {}) {
  const env = options.env ?? process.env;
  const runtime = options.runtime ?? resolveMuseRuntime({ env });
  if (runtime.platform !== "win32") {
    return { checked: false, ready: true, status: "n/a", reason: null, diagnostics: [], detail: "not applicable" };
  }
  const result = runMuse(["sandbox", "windows", "check"], { cwd, env, runtime });
  if (result.error) {
    return { checked: false, ready: true, status: "unknown", reason: result.error.message, diagnostics: [], detail: `check failed: ${result.error.message}` };
  }
  return parseWindowsSandboxCheck(`${result.stdout}\n${result.stderr}`, result.status);
}

/** `muse skills import --from claude`: Muse's own importer for Claude Code skills. */
export function runSkillsImport(cwd, options = {}) {
  const env = options.env ?? process.env;
  const args = ["skills", "import", "--from", "claude", "--json"];
  if (options.dryRun) {
    args.push("--dry-run");
  }
  if (options.force) {
    args.push("--force");
  }
  const result = runMuse(args, { cwd, env, runtime: options.runtime, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  const stdout = String(result.stdout ?? "").replace(/\0/g, "").trim();
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
  }
  if (result.status !== 0 && !parsed) {
    throw new Error((result.stderr || stdout || `muse skills import exited ${result.status}`).trim());
  }
  return {
    status: result.status,
    parsed,
    stdout,
    stderr: String(result.stderr ?? "").replace(/\0/g, ""),
    runtime: result.runtime
  };
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      ...fallback,
      parsed: null,
      parseError: fallback.failureMessage ?? "Muse did not return a final structured message.",
      rawOutput: rawOutput ?? ""
    };
  }

  const text = String(rawOutput).trim();

  try {
    return {
      ...fallback,
      parsed: JSON.parse(text),
      parseError: null,
      rawOutput: text
    };
  } catch {
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return {
        ...fallback,
        parsed: JSON.parse(fenced[1].trim()),
        parseError: null,
        rawOutput: text
      };
    } catch (error) {
      return {
        ...fallback,
        parsed: null,
        parseError: error.message,
        rawOutput: text
      };
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return {
        ...fallback,
        parsed: JSON.parse(text.slice(start, end + 1)),
        parseError: null,
        rawOutput: text
      };
    } catch (error) {
      return {
        ...fallback,
        parsed: null,
        parseError: error.message,
        rawOutput: text
      };
    }
  }

  return {
    ...fallback,
    parsed: null,
    parseError: "Could not parse structured JSON from Muse output.",
    rawOutput: text
  };
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export function schemaInstructionsFromPath(schemaPath) {
  if (!schemaPath || !fs.existsSync(schemaPath)) {
    return "";
  }
  const schema = readJsonFile(schemaPath);
  return [
    "Return only valid JSON matching this schema:",
    "```json",
    JSON.stringify(schema, null, 2),
    "```"
  ].join("\n");
}

export function buildReviewPrompt({ targetLabel, focusText, collectionGuidance, reviewInput, schemaInstructions = "" }) {
  const parts = [
    "You are performing a careful code review of the repository changes described below.",
    `Target: ${targetLabel}`,
    focusText ? `User focus: ${focusText}` : "User focus: none",
    "",
    "Rules:",
    "- Review only; do not modify files. This run has no shell and no write access.",
    "- Prefer material findings over style nits.",
    "- Ground every finding in the provided context or read-only file inspection.",
    "- Report findings ordered by severity with file paths and line numbers.",
    "- If there are no material findings, say so explicitly.",
    collectionGuidance || "Use the repository context below as primary evidence.",
    "",
    reviewInput || "(no context)",
    schemaInstructions ? `\n${schemaInstructions}` : ""
  ];
  return parts.filter((line) => line !== undefined).join("\n");
}
