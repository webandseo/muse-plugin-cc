function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  return null;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((finding, index) => normalizeReviewFinding(finding, index)),
    next_steps: data.next_steps
      .filter((step) => typeof step === "string" && step.trim())
      .map((step) => step.trim())
  };
}

function isStructuredReviewStoredResult(storedJob) {
  const result = storedJob?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(result, "result") ||
    Object.prototype.hasOwnProperty.call(result, "parseError")
  );
}

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

export function formatMuseResumeCommand(threadId) {
  if (!threadId) {
    return null;
  }
  return `muse resume ${threadId}`;
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active runs:");
  lines.push("| Run | Kind | Status | Phase | Elapsed | Muse Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/muse:runs ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/muse:stop ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.threadId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.threadId) {
    lines.push(`  Muse session ID: ${job.threadId}`);
  }
  const resumeCommand = formatMuseResumeCommand(job.threadId);
  if (resumeCommand) {
    lines.push(`  Resume in Muse: ${resumeCommand}`);
  }
  if (job.worktreePath) {
    lines.push(`  Worktree: ${job.worktreePath}${job.worktreeBranch ? ` (${job.worktreeBranch})` : ""}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Stop: /muse:stop ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Show: /muse:show ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: /muse:review --wait");
    lines.push("  Stricter pass: /muse:critique --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

export function renderSetupReport(report) {
  const lines = [
    "# Muse Code Check",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- muse: ${report.muse.detail}`,
    `- launcher: ${report.launcher.detail}`,
    `- workspace: ${report.workspace?.root ?? "unknown"}`,
    `- auth: ${report.auth.detail}`,
    `- models: ${report.models?.detail ?? "unknown"}`,
    ...(report.models?.selected ? [`- model: ${report.models.selected.detail}`] : []),
    ...(report.sandbox?.checked ? [`- windows sandbox: ${report.sandbox.detail}`] : []),
    `- git: ${report.git.detail}`,
    `- session runtime: ${report.sessionRuntime.label}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    ""
  ];

  if (report.actionsTaken?.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps?.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    const lines = [
      `# Muse Code ${meta.reviewLabel}`,
      "",
      "Muse did not return valid structured JSON.",
      "",
      `- Parse error: ${parsedResult.parseError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      `# Muse Code ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      "Muse returned JSON with an unexpected review shape.",
      "",
      `- Validation error: ${validationError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# Muse Code ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    ""
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderNativeReviewResult(result, meta) {
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  const lines = [
    `# Muse Code ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    ""
  ];

  if (stdout) {
    lines.push(stdout);
  } else if (result.status === 0) {
    lines.push("Muse review completed without any final output.");
  } else {
    lines.push("Muse review failed.");
  }

  if (stderr && (result.status !== 0 || !stdout)) {
    lines.push("", "stderr:", "", "```text", stderr, "```");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(parsedResult, meta) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  if (rawOutput) {
    return rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
  }

  const message = String(parsedResult?.failureMessage ?? "").trim() || "Muse did not return a final message.";
  return `${message}\n`;
}

export function renderStatusReport(report) {
  const lines = [
    "# Muse Code Runs",
    "",
    `Session runtime: ${report.sessionRuntime.label}`,
    `Review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    ""
  ];

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent runs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No runs recorded yet.", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# Muse Code Run Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

function appendResumeFooter(output, threadId) {
  const normalized = output.endsWith("\n") ? output : `${output}\n`;
  if (!threadId) {
    return normalized;
  }
  return `${normalized}\nMuse session ID: ${threadId}\nResume in Muse: ${formatMuseResumeCommand(threadId)}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  if (isStructuredReviewStoredResult(storedJob) && storedJob?.rendered) {
    return appendResumeFooter(storedJob.rendered, threadId);
  }

  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.muse?.stdout === "string" && storedJob.result.muse.stdout) ||
    "";
  if (rawOutput) {
    return appendResumeFooter(rawOutput, threadId);
  }

  if (storedJob?.rendered) {
    return appendResumeFooter(storedJob.rendered, threadId);
  }

  const lines = [
    `# ${job.title ?? "Muse Code Result"}`,
    "",
    `Run: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (threadId) {
    lines.push(`Muse session ID: ${threadId}`);
    lines.push(`Resume in Muse: ${formatMuseResumeCommand(threadId)}`);
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const delivered = job.cancelKill?.delivered ?? job.killDelivered;
  const lines = [
    "# Muse Code Stop",
    "",
    delivered === false
      ? `Stop requested for ${job.id}, but process kill was not confirmed.`
      : `Stopped ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  if (delivered === false) {
    lines.push("- Kill delivered: false (process may still be running).");
  }
  lines.push("- Check `/muse:runs` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTransferResult(payload) {
  const how =
    payload.mode === "native"
      ? "Muse imported the transcript itself with its resume-claude skill."
      : `Muse was seeded with a condensed transcript${payload.nativeFailure ? ` (native import fell back: ${payload.nativeFailure})` : ""}.`;
  const lines = [
    "Transferred the Claude session into a Muse Code session.",
    how,
    `Turns imported: ${payload.turnCount}${payload.truncated ? " (older turns trimmed to fit)" : ""}`,
    payload.threadId ? `Muse session ID: ${payload.threadId}` : "Muse session ID: (not detected)",
    payload.resumeCommand ? `Resume in Muse: ${payload.resumeCommand}` : "Resume with: muse resume <session-id>"
  ];
  if (payload.summary) {
    lines.push("", "Muse's handoff summary:", "", payload.summary.trim());
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
