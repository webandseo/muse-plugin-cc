import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir, withEnv } from "./helpers.mjs";
import { claimWriteSlot, partitionActiveWriteRuns, retireDeadRuns } from "../plugins/muse/scripts/lib/job-control.mjs";
import { listJobs, upsertJob } from "../plugins/muse/scripts/lib/state.mjs";

const JOB_CONTROL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "muse", "scripts", "lib", "job-control.mjs");

const NOW = Date.parse("2026-09-24T12:00:00.000Z");

function task(id, overrides = {}) {
  return {
    id,
    kind: "task",
    jobClass: "task",
    write: true,
    status: "running",
    updatedAt: "2026-09-24T11:00:00.000Z",
    ...overrides
  };
}

test("partitionActiveWriteRuns keeps write runs with a live process and flags dead ones as stale", () => {
  const alive = new Set([101]);
  const { live, stale } = partitionActiveWriteRuns(
    [
      task("run-live", { bridgePid: 999, agentPid: 101 }),
      task("run-dead", { bridgePid: 998, pid: 998 }),
      task("run-readonly", { write: false, bridgePid: 101 }),
      task("run-done", { status: "completed", bridgePid: 101 }),
      task("review-1", { jobClass: "review", kind: "review", write: false, bridgePid: 101 })
    ],
    { isAlive: (pid) => alive.has(pid), now: NOW }
  );
  assert.deepEqual(live.map((job) => job.id), ["run-live"]);
  assert.deepEqual(stale.map((job) => job.id), ["run-dead"]);
});

test("partitionActiveWriteRuns gives a run with no pid yet a short grace period", () => {
  const isAlive = () => false;
  const fresh = task("run-fresh", { status: "queued", updatedAt: new Date(NOW - 5000).toISOString() });
  const old = task("run-old", { status: "queued", updatedAt: new Date(NOW - 10 * 60 * 1000).toISOString() });
  const { live, stale } = partitionActiveWriteRuns([fresh, old], { isAlive, now: NOW });
  assert.deepEqual(live.map((job) => job.id), ["run-fresh"]);
  assert.deepEqual(stale.map((job) => job.id), ["run-old"]);
});

function newRun(repo, id) {
  return { id, kind: "task", kindLabel: "delegate", title: "Muse Code Delegate", workspaceRoot: repo, jobClass: "task", summary: id, write: true };
}

test("claimWriteSlot records the run, so a second claim is refused before the first run has started", () => {
  const repo = makeTempDir();
  withEnv({ CLAUDE_PLUGIN_DATA: makeTempDir() }, () => {
    const first = claimWriteSlot(repo, newRun(repo, "run-first"));
    assert.equal(first.claimed, true);

    const second = claimWriteSlot(repo, newRun(repo, "run-second"));
    assert.equal(second.claimed, false);
    assert.equal(second.active.id, "run-first");

    const jobs = listJobs(repo);
    assert.deepEqual(jobs.map((job) => job.id), ["run-first"], "a refused claim is not recorded");
    assert.equal(jobs[0].status, "queued");
  });
});

test("claimWriteSlot is not blocked by a write run whose processes are gone", () => {
  const repo = makeTempDir();
  withEnv({ CLAUDE_PLUGIN_DATA: makeTempDir() }, () => {
    upsertJob(repo, { ...newRun(repo, "run-dead"), status: "running", bridgePid: 998, pid: 998 });
    const claim = claimWriteSlot(repo, newRun(repo, "run-next"), { isAlive: () => false });
    assert.equal(claim.claimed, true);
    assert.equal(claim.active, null);
  });
});

test("retireDeadRuns marks every active run whose processes are gone as failed and leaves the rest alone", () => {
  const repo = makeTempDir();
  withEnv({ CLAUDE_PLUGIN_DATA: makeTempDir() }, () => {
    const alive = new Set([101]);
    const review = { jobClass: "review", kind: "review", write: false };
    upsertJob(repo, { ...newRun(repo, "review-dead"), ...review, status: "running", bridgePid: 998, agentPid: 997 });
    upsertJob(repo, { ...newRun(repo, "run-dead"), write: false, status: "running", bridgePid: 996 });
    upsertJob(repo, { ...newRun(repo, "run-live"), status: "running", bridgePid: 999, agentPid: 101 });
    upsertJob(repo, { ...newRun(repo, "run-done"), status: "completed", bridgePid: 995 });

    const retired = retireDeadRuns(repo, { isAlive: (pid) => alive.has(pid) });

    assert.deepEqual(retired.map((job) => job.id).sort(), ["review-dead", "run-dead"]);
    const byId = Object.fromEntries(listJobs(repo).map((job) => [job.id, job]));
    assert.equal(byId["review-dead"].status, "failed");
    assert.match(byId["review-dead"].errorMessage, /no longer running/);
    assert.equal(byId["run-dead"].status, "failed");
    assert.equal(byId["run-live"].status, "running");
    assert.equal(byId["run-done"].status, "completed");
  });
});

test("claimWriteSlot lets exactly one of several racing processes claim the slot", async () => {
  const repo = makeTempDir();
  const pluginDataDir = makeTempDir();
  // Every racer loads the module first, then blocks until the same instant,
  // so the claims overlap instead of being spread over node's startup time.
  const startAt = Date.now() + 2000;
  const script = [
    `import { claimWriteSlot } from ${JSON.stringify(pathToFileURL(JOB_CONTROL).href)};`,
    "const wait = Number(process.env.START_AT) - Date.now();",
    "if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);",
    "const repo = process.env.RACE_REPO;",
    "const id = process.env.RACE_ID;",
    "const result = claimWriteSlot(repo, { id, kind: 'task', jobClass: 'task', workspaceRoot: repo, write: true });",
    "process.stdout.write(JSON.stringify({ id, claimed: result.claimed }));"
  ].join("\n");

  const racers = Array.from({ length: 4 }, (_, index) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataDir, RACE_REPO: repo, RACE_ID: `run-racer-${index}`, START_AT: String(startAt) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `racer exited ${code}`))));
    })
  );

  const results = await Promise.all(racers);
  const winners = results.filter((result) => result.claimed);
  assert.equal(winners.length, 1, JSON.stringify(results));
  withEnv({ CLAUDE_PLUGIN_DATA: pluginDataDir }, () => {
    assert.deepEqual(listJobs(repo).map((job) => job.id), [winners[0].id]);
  });
});
