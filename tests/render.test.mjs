import test from "node:test";
import assert from "node:assert/strict";

import {
  renderCancelReport,
  renderReviewResult,
  renderRunMode,
  renderStoredJobResult,
  renderTransferResult
} from "../plugins/muse/scripts/lib/render.mjs";

test("renderReviewResult orders findings by severity and keeps line ranges", () => {
  const rendered = renderReviewResult(
    {
      parsed: {
        verdict: "needs-attention",
        summary: "Two problems.",
        findings: [
          { severity: "low", title: "Nit", body: "meh", file: "a.js", line_start: 1, line_end: 1, confidence: 0.4, recommendation: "" },
          { severity: "critical", title: "Boom", body: "bad", file: "b.js", line_start: 10, line_end: 12, confidence: 0.9, recommendation: "fix" }
        ],
        next_steps: ["Fix Boom"]
      },
      parseError: null,
      rawOutput: "{}"
    },
    { reviewLabel: "Critique", targetLabel: "working tree diff" }
  );
  assert.match(rendered, /# Muse Code Critique/);
  assert.match(rendered, /Verdict: needs-attention/);
  assert.ok(rendered.indexOf("[critical] Boom (b.js:10-12)") < rendered.indexOf("[low] Nit (a.js:1)"));
  assert.match(rendered, /Recommendation: fix/);
  assert.match(rendered, /- Fix Boom/);
});

test("renderReviewResult explains parse failures with the raw message", () => {
  const rendered = renderReviewResult(
    { parsed: null, parseError: "Unexpected token", rawOutput: "not json" },
    { reviewLabel: "Critique", targetLabel: "x" }
  );
  assert.match(rendered, /did not return valid structured JSON/);
  assert.match(rendered, /not json/);
});

test("renderStoredJobResult appends the muse resume footer", () => {
  const rendered = renderStoredJobResult(
    { id: "run-1", status: "completed", title: "Muse Code Delegate" },
    { threadId: "abc-123", result: { rawOutput: "Did the thing." } }
  );
  assert.match(rendered, /Did the thing\./);
  assert.match(rendered, /Muse session ID: abc-123/);
  assert.match(rendered, /Resume in Muse: muse resume abc-123/);
});

test("renderCancelReport and renderTransferResult produce actionable text", () => {
  const cancel = renderCancelReport({ id: "run-9", title: "Muse Code Review", killDelivered: false });
  assert.match(cancel, /process kill was not confirmed/);
  assert.match(cancel, /\/muse:runs/);

  const transfer = renderTransferResult({
    threadId: "t-1",
    resumeCommand: "muse resume t-1",
    turnCount: 4,
    truncated: true,
    summary: "Next: run tests."
  });
  assert.match(transfer, /Turns imported: 4 \(older turns trimmed to fit\)/);
  assert.match(transfer, /muse resume t-1/);
  assert.match(transfer, /Next: run tests\./);
});

test("renderCancelReport says whether the stopped run could edit files, and where", () => {
  const write = renderCancelReport({ id: "run-1", write: true, worktree: false });
  assert.match(write, /- Mode: write-capable/);
  assert.match(write, /partial edits in the working tree/);

  const worktree = renderCancelReport({ id: "run-2", write: true, worktree: true });
  assert.match(worktree, /- Mode: write-capable, in its own worktree/);
  assert.match(worktree, /not in the main working tree/);

  const readOnly = renderCancelReport({ id: "run-3", write: false });
  assert.match(readOnly, /- Mode: read-only/);
  assert.doesNotMatch(readOnly, /partial edits/);

  assert.equal(renderRunMode({ id: "run-4" }), null, "older records without the flag claim nothing");
  assert.doesNotMatch(renderCancelReport({ id: "run-4" }), /Mode:/);
});
