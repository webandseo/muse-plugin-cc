import test from "node:test";
import assert from "node:assert/strict";

import { partitionActiveWriteRuns } from "../plugins/muse/scripts/lib/job-control.mjs";

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
