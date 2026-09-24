#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { buildTranscriptMarkdown, resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import {
  buildReviewPrompt,
  DEFAULT_CONTINUE_PROMPT,
  DEFAULT_MODEL_ALIAS,
  describeRuntime,
  DISABLE_SANDBOX_ENV,
  getMuseAuthStatus,
  getMuseAvailability,
  getWindowsSandboxStatus,
  MODEL_ALIASES,
  MODEL_ENV,
  normalizeRequestedModel,
  parseStructuredOutput,
  readModelCatalog,
  readOutputSchema,
  resolveModelSelection,
  resolveMuseRuntime,
  runHeadlessAgent,
  runSkillsImport,
  schemaInstructionsFromPath,
  VALID_REASONING_EFFORTS
} from "./lib/muse.mjs";
import { createSessionWorktree, removeSessionWorktree } from "./lib/git.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  filterJobsForSession,
  getSessionRuntimeStatus,
  partitionActiveWriteRuns,
  readStoredJob,
  resolveCancelableJob,
  resolveJobKindLabel,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  claimJobTerminal,
  generateJobId,
  getConfig,
  listJobs,
  patchJobIfActive,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  resolveJobKillTargets,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  formatMuseResumeCommand,
  renderCancelReport,
  renderJobStatusReport,
  renderNativeReviewResult,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult,
  renderTransferResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const REASONING_EFFORTS = new Set(VALID_REASONING_EFFORTS);
const STOP_GATE_KIND = "stop-gate";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/muse-bridge.mjs check [--json] [--probe] [--model <model|alias>] [--enable-review-gate|--disable-review-gate]",
      "  node scripts/muse-bridge.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <effort>]",
      "  node scripts/muse-bridge.mjs critique [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <effort>] [focus text]",
      "  node scripts/muse-bridge.mjs run [--background] [--write] [--allow-concurrent] [--worktree [--worktree-base <ref>]] [--image <path>] [--resume-last|--resume|--fresh] [--model <model|alias>] [--effort <effort>] [prompt]",
      "  node scripts/muse-bridge.mjs transfer [--source <claude-jsonl>] [--condensed] [--model <model|alias>] [--effort <effort>] [--json]",
      "  node scripts/muse-bridge.mjs sync-skills [--dry-run] [--force] [--json]",
      "  node scripts/muse-bridge.mjs runs [run-id] [--wait] [--timeout-ms <ms>] [--all] [--json]",
      "  node scripts/muse-bridge.mjs show [run-id] [--json]",
      "  node scripts/muse-bridge.mjs stop [run-id] [--json]",
      "",
      `Effort values: ${VALID_REASONING_EFFORTS.join(", ")}`,
      `Model aliases: ${[...MODEL_ALIASES].map(([alias, model]) => `${alias} → ${model}`).join(", ")}`,
      `Default model: ${DEFAULT_MODEL_ALIAS} (${normalizeRequestedModel(DEFAULT_MODEL_ALIAS)}) unless --model or ${MODEL_ENV} names another`
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: ${VALID_REASONING_EFFORTS.join(", ")}.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  const parsed = parseArgs(normalizeArgv(argv), {
    ...config,
    unknownMode: config.unknownMode ?? "warn",
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
  if (parsed.unknown?.length) {
    for (const token of parsed.unknown) {
      process.stderr.write(`Warning: ignoring unknown option ${token}\n`);
    }
  }
  return parsed;
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

function describeModelSource(selection) {
  switch (selection.source) {
    case "flag":
      return `from --model ${selection.requested}`;
    case "env":
      return `from ${MODEL_ENV}=${selection.requested}`;
    default:
      return `plugin default \`${DEFAULT_MODEL_ALIAS}\`; set ${MODEL_ENV} or pass --model to change it`;
  }
}

async function runAuthProbe(cwd, model) {
  const result = await runHeadlessAgent(cwd, {
    prompt: "Reply with exactly the single word OK and nothing else.",
    write: false,
    shell: false,
    webTools: false,
    trustWorkspace: false,
    model,
    effort: "low",
    maxModelSteps: 1
  });
  return {
    verified: result.status === 0 && result.terminal === "completed",
    detail:
      result.status === 0
        ? `probe succeeded (model ${result.model ?? "unknown"})`
        : `probe failed: ${shorten(result.failureDetail || `exit ${result.status}`)}`
  };
}

async function buildCheckReport(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  // We are already running under node; report the interpreter that Claude
  // Code resolved rather than probing PATH through a shell.
  const nodeStatus = binaryAvailable(process.execPath, ["--version"], { cwd });
  const gitStatus = binaryAvailable("git", ["--version"], { cwd });
  const runtime = resolveMuseRuntime({ env: process.env });
  const museStatus = getMuseAvailability(cwd, { runtime });
  const authStatus = getMuseAuthStatus(cwd, { availability: museStatus });
  const config = getConfig(workspaceRoot);
  const sandbox = museStatus.available ? getWindowsSandboxStatus(cwd, { runtime }) : { checked: false, ready: true, detail: "not applicable" };
  const catalog = museStatus.available ? readModelCatalog({ runtime }) : [];
  const defaultModel = catalog.find((row) => row.isDefault) ?? null;
  const selection = resolveModelSelection(options.model, process.env);
  const selectedNote = catalog.find((row) => row.id === selection.model)?.description ?? null;
  const models = {
    available: catalog.map((row) => row.id),
    default: defaultModel?.id ?? null,
    aliases: Object.fromEntries(MODEL_ALIASES),
    note: defaultModel?.description ?? null,
    detail:
      catalog.length === 0
        ? "catalog not cached yet (populated after Muse's first run); pass --model to choose explicitly"
        : `${catalog.map((row) => (row.isDefault ? `${row.id} (Muse default)` : row.id)).join(", ")}${
            defaultModel?.description ? ` — note: ${defaultModel.description}` : ""
          }`,
    // What the bridge will actually pass as --model, and why.
    selected: {
      id: selection.model,
      source: selection.source,
      requested: selection.requested,
      note: selectedNote,
      detail: `${selection.model} (${describeModelSource(selection)})${selectedNote ? `; note: ${selectedNote}` : ""}`
    }
  };

  if (options.probe && museStatus.available && authStatus.loggedIn) {
    const probe = await runAuthProbe(workspaceRoot, selection.model);
    authStatus.verified = probe.verified;
    authStatus.detail = `${authStatus.detail}; ${probe.detail}`;
    if (!probe.verified) {
      authStatus.loggedIn = false;
    }
  }

  const nextSteps = [];
  if (!nodeStatus.available) {
    nextSteps.push("Install Node.js 20 or later and make sure `node` is on PATH.");
  }
  if (!museStatus.available) {
    nextSteps.push(
      runtime.platform === "win32"
        ? "Install Muse Code (PowerShell: `irm https://dev.meta.ai/install.ps1 | iex`) and open a new terminal so `muse` is on PATH, or set MUSE_BINARY."
        : "Install Muse Code (`curl https://dev.meta.ai/install.sh | bash`) and make sure `muse` is on PATH, or set MUSE_BINARY."
    );
  }
  if (museStatus.available && !authStatus.loggedIn) {
    nextSteps.push("Authenticate Muse: run `muse login` (or `muse auth set --api-key-stdin`).");
    nextSteps.push("Then rerun `/muse:check`. Add `--probe` to confirm with a one-step model call.");
  }
  if (sandbox.checked && !sandbox.ready) {
    nextSteps.push(
      `Muse's shell tool needs its Windows sandbox (${sandbox.detail}). Run \`muse sandbox windows setup\` once in an elevated PowerShell. Reviews work without it; delegate runs cannot run commands until then, or set ${DISABLE_SANDBOX_ENV}=1 to run delegates with --disable-sandbox.`
    );
  }

  return {
    ready: nodeStatus.available && museStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    muse: { available: museStatus.available, detail: museStatus.detail, binary: museStatus.binary },
    launcher: {
      binary: runtime.binary,
      reason: runtime.reason,
      detail: describeRuntime(runtime)
    },
    workspace: { root: workspaceRoot },
    auth: authStatus,
    models,
    sandbox,
    git: gitStatus,
    sessionRuntime: getSessionRuntimeStatus(),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken: options.actionsTaken ?? [],
    nextSteps
  };
}

async function handleCheck(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "model"],
    booleanOptions: ["json", "probe", "enable-review-gate", "disable-review-gate"],
    aliasMap: {
      m: "model"
    }
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const actionsTaken = [];
  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push("Enabled the stop-time review gate for this repository.");
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push("Disabled the stop-time review gate for this repository.");
  }

  const finalReport = await buildCheckReport(cwd, { actionsTaken, probe: options.probe, model: options.model });
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildCritiquePrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "critique");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Critique",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureMuseAvailable(cwd) {
  const availability = getMuseAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      `Muse Code is not reachable (${availability.detail}). Install it, set MUSE_BINARY if needed, then rerun \`/muse:check\`.`
    );
  }
  return availability;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  return filterJobsForSession(jobs, { sessionId: getCurrentClaudeSessionId() });
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.kind !== STOP_GATE_KIND &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find(
    (job) => job.jobClass === "task" && job.kind !== STOP_GATE_KIND && (job.status === "queued" || job.status === "running")
  );
  if (activeTask) {
    throw new Error(`Delegate run ${activeTask.id} is still running. Use /muse:runs before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  return null;
}

/**
 * Two write-capable runs in one checkout edit the same files at once. Refuse
 * a new one while another is alive; retire records whose processes are gone
 * (a killed worker, a closed terminal) so they do not block forever.
 */
function ensureNoConcurrentWriteRun(workspaceRoot) {
  const { live, stale } = partitionActiveWriteRuns(sortJobsNewestFirst(listJobs(workspaceRoot)));
  for (const job of stale) {
    const errorMessage = "The run's bridge and Muse processes are no longer running; marked failed.";
    appendLogLine(job.logFile, errorMessage);
    claimJobTerminal(workspaceRoot, job.id, "failed", { errorMessage, phase: "failed", bridgePid: null });
  }
  const active = live[0];
  if (!active) {
    return;
  }
  throw new Error(
    [
      `Muse delegate run ${active.id} is still ${active.status} with write access in this repository, so a second write-capable run was not started.`,
      `Wait for it: /muse:runs ${active.id} --wait`,
      `Stop it:     /muse:stop ${active.id}`,
      "Pass --allow-concurrent to start another one anyway."
    ].join("\n")
  );
}

async function executeReviewRun(request) {
  ensureMuseAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  const context = collectReviewContext(request.cwd, target);

  let prompt;
  let structured = false;
  if (reviewName === "Critique") {
    prompt = buildCritiquePrompt(context, focusText);
    const schemaHint = schemaInstructionsFromPath(REVIEW_SCHEMA);
    if (schemaHint) {
      prompt = `${prompt}\n\n${schemaHint}`;
    }
    structured = true;
  } else {
    prompt = buildReviewPrompt({
      targetLabel: context.target.label,
      focusText,
      collectionGuidance: context.collectionGuidance,
      reviewInput: context.content
    });
  }

  // Reviews are strictly read-only: no shell, no writes, no web. Muse can
  // still read files, and the diff is inlined for it.
  const result = await runHeadlessAgent(context.repoRoot, {
    prompt,
    write: false,
    shell: false,
    webTools: false,
    trustWorkspace: false,
    model: request.model,
    effort: request.effort,
    outputSchema: structured ? readOutputSchema(REVIEW_SCHEMA) : undefined,
    lastMessageOnly: true,
    onProgress: request.onProgress
  });

  const failureMessage = result.status === 0 ? "" : result.failureDetail || result.stderr || "";

  if (structured) {
    const parsed = parseStructuredOutput(result.finalMessage, {
      status: result.status,
      failureMessage
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      model: result.model,
      context: {
        repoRoot: context.repoRoot,
        branch: context.branch,
        summary: context.summary,
        inputMode: context.inputMode
      },
      muse: {
        status: result.status,
        terminal: result.terminal,
        stderr: result.stderr,
        stdout: result.finalMessage
      },
      result: parsed.parsed,
      rawOutput: parsed.rawOutput,
      parseError: parsed.parseError
    };

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: null,
      payload,
      rendered: renderReviewResult(parsed, {
        reviewLabel: reviewName,
        targetLabel: context.target.label
      }),
      summary:
        parsed.parsed?.summary ??
        parsed.parseError ??
        firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
      jobTitle: `Muse Code ${reviewName}`,
      jobClass: "review",
      targetLabel: context.target.label
    };
  }

  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    model: result.model,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary,
      inputMode: context.inputMode
    },
    muse: {
      status: result.status,
      terminal: result.terminal,
      stderr: result.stderr,
      stdout: result.finalMessage
    },
    rawOutput: result.finalMessage
  };
  const rendered = renderNativeReviewResult(
    {
      status: result.status,
      stdout: result.finalMessage,
      stderr: failureMessage
    },
    { reviewLabel: reviewName, targetLabel: target.label }
  );

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: null,
    payload,
    rendered,
    summary: firstMeaningfulLine(result.finalMessage, `${reviewName} completed.`),
    jobTitle: `Muse Code ${reviewName}`,
    jobClass: "review",
    targetLabel: target.label
  };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureMuseAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast,
    stopGate: request.stopGate
  });

  let resumeSessionId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Muse Code delegate session was found for this repository.");
    }
    resumeSessionId = latestThread.id;
  }

  if (!request.prompt && !resumeSessionId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const prompt = String(request.prompt ?? "").trim() || (resumeSessionId ? DEFAULT_CONTINUE_PROMPT : "");
  const write = Boolean(request.write);
  const stopGate = Boolean(request.stopGate);
  const runtime = resolveMuseRuntime({ env: process.env });
  const nativeWindows = runtime.platform === "win32";

  // The bridge creates the worktree itself (git worktree add on branch
  // muse/session-<id>) and hands it to Muse as existing. One code path on
  // every platform, and Muse's own `--worktree create` fails on Windows.
  let ownedWorktree = null;
  let sessionId = resumeSessionId ?? undefined;
  if (request.worktree && write) {
    sessionId = crypto.randomUUID();
    ownedWorktree = createSessionWorktree(workspaceRoot, sessionId, { base: request.worktreeBase ?? null });
    request.onProgress?.({ message: `Created worktree ${ownedWorktree.path} on ${ownedWorktree.branch}.`, phase: "starting" });
  }

  // Write-capable delegate runs get the shell and the workspace's own skills
  // and rules; read-only runs keep only file reading. Approval prompts are
  // always off because nobody is there to answer them.
  let result;
  try {
    result = await runHeadlessAgent(workspaceRoot, {
      prompt,
      sessionId,
      model: request.model,
      effort: request.effort,
      write,
      shell: write,
      trustWorkspace: !stopGate,
      webTools: !stopGate,
      worktreeExisting: ownedWorktree?.path ?? null,
      images: request.images ?? [],
      // Opt-in only: the native Windows sandbox needs an elevated setup and
      // some users would rather run without it than set it up.
      disableSandbox: write && nativeWindows && process.env[DISABLE_SANDBOX_ENV] === "1",
      onProgress: request.onProgress
    });
  } catch (error) {
    if (ownedWorktree) {
      removeSessionWorktree(ownedWorktree.repoRoot, ownedWorktree);
    }
    throw error;
  }

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.status === 0 ? "" : result.failureDetail || result.stderr || "";
  const worktree = ownedWorktree ? { path: ownedWorktree.path, branch: ownedWorktree.branch } : null;
  const rendered =
    renderTaskResult(
      {
        rawOutput,
        failureMessage
      },
      {
        title: taskMetadata.title,
        jobId: request.jobId ?? null,
        write
      }
    ) +
    renderWorktreeFooter(worktree, workspaceRoot) +
    (stopGate ? "" : renderSessionFooter(result.threadId));
  const payload = {
    status: result.status,
    terminal: result.terminal,
    threadId: result.threadId,
    model: result.model,
    resumed: Boolean(resumeSessionId),
    write,
    worktree,
    images: request.images ?? [],
    rawOutput,
    failureMessage,
    resumeCommand: formatMuseResumeCommand(result.threadId)
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: null,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write,
    worktreePath: worktree?.path ?? null,
    worktreeBranch: worktree?.branch ?? null
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Critique" ? "critique" : "review",
    title: `Muse Code ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false, stopGate = false }) {
  const title = stopGate ? "Muse Code Stop Gate" : resumeLast ? "Muse Code Resume" : "Muse Code Delegate";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Delegate";
  return {
    title,
    summary: stopGate ? "Stop-time review of the previous Claude turn" : shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /muse:runs ${payload.jobId} for progress.\n`;
}

function createBridgeJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: kind === STOP_GATE_KIND ? STOP_GATE_KIND : resolveJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write, stopGate = false) {
  return createBridgeJob({
    prefix: stopGate ? "gate" : "run",
    kind: stopGate ? STOP_GATE_KIND : "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId, stopGate, worktree, worktreeBase, images }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId,
    stopGate,
    worktree: Boolean(worktree),
    worktreeBase: worktreeBase ?? null,
    images: images ?? []
  };
}

function renderSessionFooter(threadId) {
  const resume = formatMuseResumeCommand(threadId);
  if (!resume) {
    return "";
  }
  return `\nMuse session ID: ${threadId}\nResume in Muse: ${resume}\n`;
}

function renderWorktreeFooter(worktree, workspaceRoot) {
  if (!worktree?.path) {
    return "";
  }
  const lines = [
    "",
    `Worktree: ${worktree.path}`,
    `Branch: ${worktree.branch}`,
    `Inspect: git -C "${workspaceRoot}" diff HEAD...${worktree.branch}`,
    `Merge:   git -C "${workspaceRoot}" merge ${worktree.branch}`,
    `Discard: git -C "${workspaceRoot}" worktree remove --force "${worktree.path}" && git -C "${workspaceRoot}" branch -D ${worktree.branch}`
  ];
  return `${lines.join("\n")}\n`;
}

function renderSkillsSyncResult(payload) {
  const lines = [`# Muse Code Skills Sync${payload.dryRun ? " (dry run)" : ""}`, ""];
  if (payload.source?.path) {
    lines.push(`Source: ${payload.source.path} (${payload.launcher})`);
  }
  const groups = [
    ["Installed", payload.installed],
    ["Would install", payload.dryRun ? payload.candidates : []],
    ["Skipped", payload.skipped],
    ["Failed", payload.failed],
    ["Quarantined", payload.quarantined]
  ];
  let any = false;
  for (const [label, entries] of groups) {
    if (!Array.isArray(entries) || entries.length === 0) {
      continue;
    }
    any = true;
    lines.push("", `${label}:`);
    for (const entry of entries) {
      const name = typeof entry === "string" ? entry : entry?.name ?? entry?.id ?? entry?.path ?? JSON.stringify(entry);
      const reason = entry && typeof entry === "object" && entry.reason ? ` — ${entry.reason}` : "";
      lines.push(`- ${name}${reason}`);
    }
  }
  if (!any) {
    lines.push("", "No Claude Code skills found to import (Muse reads ~/.claude/skills in the environment where it runs).");
  }
  if (payload.raw) {
    lines.push("", "```text", payload.raw, "```");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function runNativeTransfer(workspaceRoot, sourcePath, transcript, options = {}) {
  // Muse's bundled `resume-claude` skill reads Claude Code transcripts itself.
  // Hand it the file path and let it do the import natively.
  const template = loadPromptTemplate(ROOT_DIR, "transfer-native");
  const prompt = interpolateTemplate(template, {
    REPO_ROOT: workspaceRoot,
    TRANSCRIPT_PATH: sourcePath,
    CLAUDE_SESSION_ID: transcript.claudeSessionId ?? path.basename(sourcePath, ".jsonl"),
    TURN_COUNT: String(transcript.turnCount)
  });
  options.onProgress?.({ message: "Asking Muse to import the Claude session with its resume-claude skill.", phase: "transferring" });
  return runHeadlessAgent(workspaceRoot, {
    prompt,
    write: false,
    shell: false,
    webTools: false,
    trustWorkspace: true,
    maxModelSteps: 24,
    model: options.model,
    effort: options.effort ?? "low",
    onProgress: options.onProgress
  });
}

async function runCondensedTransfer(workspaceRoot, transcript, options = {}) {
  const template = loadPromptTemplate(ROOT_DIR, "transfer");
  const prompt = interpolateTemplate(template, {
    REPO_ROOT: workspaceRoot,
    TURN_COUNT: String(transcript.turnCount),
    TRANSCRIPT: transcript.markdown
  });
  options.onProgress?.({ message: "Seeding a new Muse session with a condensed Claude transcript.", phase: "transferring" });
  return runHeadlessAgent(workspaceRoot, {
    prompt,
    write: false,
    shell: false,
    webTools: false,
    trustWorkspace: true,
    maxModelSteps: 2,
    model: options.model,
    effort: options.effort ?? "low",
    onProgress: options.onProgress
  });
}

function transferLooksSuccessful(result) {
  return result.status === 0 && result.terminal !== "failed" && String(result.finalMessage ?? "").trim().length > 0;
}

async function executeTransfer(cwd, options = {}) {
  ensureMuseAvailable(cwd);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const transcript = buildTranscriptMarkdown(sourcePath);

  let mode = options.condensed ? "condensed" : "native";
  let result = null;
  let nativeFailure = null;
  if (mode === "native") {
    result = await runNativeTransfer(workspaceRoot, sourcePath, transcript, options);
    if (!transferLooksSuccessful(result)) {
      nativeFailure = shorten(result.failureDetail || result.stderr || `exit ${result.status}`, 200);
      options.onProgress?.({
        message: `Native import did not complete (${nativeFailure}); falling back to a condensed transcript.`,
        phase: "transferring"
      });
      mode = "condensed";
      result = null;
    }
  }
  if (!result) {
    result = await runCondensedTransfer(workspaceRoot, transcript, options);
  }

  if (!transferLooksSuccessful(result)) {
    throw new Error(
      `Muse could not absorb the transcript: ${shorten(result.failureDetail || result.stderr || `exit ${result.status}`, 300)}`
    );
  }

  const payload = {
    mode,
    nativeFailure,
    threadId: result.threadId,
    resumeCommand: formatMuseResumeCommand(result.threadId),
    workspaceRoot,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl"),
    claudeSessionId: transcript.claudeSessionId,
    turnCount: transcript.turnCount,
    truncated: mode === "condensed" ? transcript.truncated : false,
    model: result.model,
    summary: result.finalMessage
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedRunWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "muse-bridge.mjs");
  const child = spawn(process.execPath, [scriptPath, "run-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

export function enqueueBackgroundJob(cwd, job, request, options = {}) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    agentPid: null,
    bridgePid: null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  const spawnWorker = options.spawnWorker ?? spawnDetachedRunWorker;
  const child = spawnWorker(cwd, job.id);
  const workerPid = child?.pid ?? null;
  if (workerPid != null) {
    patchJobIfActive(job.workspaceRoot, job.id, {
      status: "queued",
      phase: "queued",
      pid: workerPid,
      bridgePid: workerPid,
      agentPid: null,
      logFile,
      request
    });
  }

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile,
      bridgePid: workerPid,
      pid: workerPid
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createBridgeJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });

  const request = {
    kind: "review",
    cwd,
    base: options.base,
    scope: options.scope,
    model,
    effort,
    focusText,
    reviewName: config.reviewName
  };

  if (options.background && !options.wait) {
    ensureMuseAvailable(cwd);
    const { payload } = enqueueBackgroundJob(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(job, (progress) => executeReviewRun({ ...request, onProgress: progress }), {
    json: options.json
  });
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review"
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "image", "worktree-base"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "stop-gate", "worktree", "allow-concurrent"],
    aliasMap: {
      m: "model",
      w: "worktree"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const stopGate = Boolean(options["stop-gate"]);
  const write = Boolean(options.write) && !stopGate;
  const worktree = Boolean(options.worktree) && !stopGate;
  const worktreeBase = options["worktree-base"] ? String(options["worktree-base"]).trim() : null;
  const images = options.image ? [path.resolve(cwd, String(options.image))] : [];
  if (worktree && resumeLast) {
    throw new Error("--worktree starts a fresh isolated session; it cannot be combined with --resume/--resume-last.");
  }
  if (worktree && !write) {
    throw new Error("--worktree only makes sense for a write-capable run; add --write.");
  }
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast,
    stopGate
  });

  if (write && !options["allow-concurrent"]) {
    ensureNoConcurrentWriteRun(workspaceRoot);
  }

  if (options.background) {
    ensureMuseAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write, stopGate);
    const request = {
      kind: "task",
      ...buildTaskRequest({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        stopGate,
        worktree,
        worktreeBase,
        images
      })
    };
    const { payload } = enqueueBackgroundJob(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write, stopGate);
  if (!options.json) {
    // If the caller's shell gives up on us (Claude Code's Bash tool backgrounds
    // a call after its timeout), this is how to find the run instead of
    // starting it again.
    process.stderr.write(
      `[muse-cc] Tracking this run as ${job.id}. If this call is backgrounded or times out, use /muse:runs ${job.id} --wait instead of starting another run.\n`
    );
  }
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        stopGate,
        worktree,
        worktreeBase,
        images,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleSyncSkills(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "dry-run", "force"]
  });
  const cwd = resolveCommandCwd(options);
  ensureMuseAvailable(cwd);
  const result = runSkillsImport(cwd, { dryRun: options["dry-run"], force: options.force });
  const parsed = result.parsed ?? {};
  const payload = {
    dryRun: Boolean(parsed.dry_run ?? options["dry-run"]),
    source: parsed.source ?? null,
    candidates: parsed.candidates ?? [],
    installed: parsed.installed ?? [],
    skipped: parsed.skipped ?? [],
    failed: parsed.failed ?? [],
    quarantined: parsed.quarantined ?? [],
    launcher: describeRuntime(result.runtime),
    raw: result.parsed ? null : result.stdout
  };
  outputCommandResult(payload, renderSkillsSyncResult(payload), options.json);
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source", "model", "effort"],
    booleanOptions: ["json", "condensed"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const progress = options.json
    ? null
    : createProgressReporter({ stderr: true });
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source,
    condensed: Boolean(options.condensed),
    model: normalizeRequestedModel(options.model),
    effort: normalizeReasoningEffort(options.effort) ?? undefined,
    onProgress: progress
  });
  outputCommandResult(payload, rendered, options.json);
}

async function readStoredJobWithRetry(workspaceRoot, jobId, options = {}) {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 25;
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = readStoredJob(workspaceRoot, jobId);
    if (last) {
      return last;
    }
    await sleep(delayMs);
  }
  return last;
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for run-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = await readStoredJobWithRetry(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its run request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );

  const runner =
    request.kind === "review" || storedJob.jobClass === "review"
      ? () => executeReviewRun({ ...request, onProgress: progress })
      : () => executeTaskRun({ ...request, onProgress: progress });

  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    runner,
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`runs --wait` requires a run id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable delegate run found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable delegate run found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

function terminateJobProcessTrees(job) {
  const targets = resolveJobKillTargets(job);
  const results = [];
  for (const pid of targets) {
    results.push({ pid, ...terminateProcessTree(pid) });
  }
  if (results.length === 0) {
    return { attempted: false, delivered: false, method: null, results: [] };
  }
  return {
    attempted: results.some((entry) => entry.attempted),
    delivered: results.some((entry) => entry.delivered),
    method: results.map((entry) => entry.method).filter(Boolean).join("+") || null,
    results
  };
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? job;
  const preClaimRecord = { ...job, ...existing };
  const killTargets = resolveJobKillTargets(preClaimRecord);

  const claim = claimJobTerminal(workspaceRoot, job.id, "cancelled", {
    errorMessage: "Stopped by user.",
    phase: "cancelled",
    pid: null,
    agentPid: null,
    bridgePid: null,
    logFile: existing.logFile ?? job.logFile ?? null
  });

  const killResult = terminateJobProcessTrees(preClaimRecord);

  if (!claim.claimed && claim.status && claim.status !== "cancelled") {
    const payload = {
      jobId: job.id,
      status: claim.status,
      title: claim.job?.title ?? job.title,
      killAttempted: killResult.attempted,
      killDelivered: killResult.delivered,
      alreadyTerminal: true,
      claimOrder: "claim-before-kill",
      killTargets
    };
    outputCommandResult(
      payload,
      `Job ${job.id} is already ${claim.status}; not overwritten by stop.\n`,
      options.json
    );
    return;
  }

  appendLogLine(
    existing.logFile ?? job.logFile,
    killResult.delivered
      ? "Stopped by user (claim-before-kill)."
      : `Stop claimed; process tree kill delivered=${killResult.delivered} method=${killResult.method ?? "none"}.`
  );

  const merged = claimJobTerminal(workspaceRoot, job.id, "cancelled", {
    errorMessage: killResult.delivered
      ? "Stopped by user."
      : "Stop claimed but process may still be running (kill not delivered).",
    cancelKill: killResult,
    logFile: existing.logFile ?? job.logFile ?? null
  });

  const nextJob = merged.job ?? claim.job ?? {
    ...existing,
    status: "cancelled",
    phase: "cancelled",
    title: job.title
  };
  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    killAttempted: killResult.attempted,
    killDelivered: killResult.delivered,
    killMethod: killResult.method,
    killTargets,
    claimOrder: "claim-before-kill",
    claimed: claim.claimed
  };

  outputCommandResult(payload, renderCancelReport({ ...nextJob, ...payload }), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "check":
    case "setup":
      await handleCheck(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "critique":
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Critique"
      });
      break;
    case "run":
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
    case "import":
      await handleTransfer(argv);
      break;
    case "sync-skills":
      await handleSyncSkills(argv);
      break;
    case "run-worker":
      await handleTaskWorker(argv);
      break;
    case "runs":
    case "status":
      await handleStatus(argv);
      break;
    case "show":
    case "result":
      handleResult(argv);
      break;
    case "run-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "stop":
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

export { main, readStoredJobWithRetry };
