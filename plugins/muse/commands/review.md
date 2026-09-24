---
description: Run a Muse Code code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Muse Code review through the plugin bridge (read-only: no shell, no writes).

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Muse's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not add extra review instructions or rewrite the user's intent.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the bridge call; do not treat them as review focus text.
- Leave `--model` and `--effort` unset unless the user explicitly asks for them. Without `--model` the bridge uses `MUSE_CC_MODEL`, or else `spark` (`muse-spark-1.3`), never Muse's contributor default. Accepted effort values: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`.
- The bridge script parses `--wait` and `--background`. Bridge `--background` owns the long-running process group (detached `run-worker` + muse child). Claude Code's `Bash(..., run_in_background: true)` is only for the short enqueue call, not the long review process.
- `/muse:review` does not support staged-only review, unstaged-only review, or extra focus text.
- If the user needs a tougher design challenge pass, they should use `/muse:critique`.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-bridge.mjs" review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Prefer the bridge's own detached worker so stop owns a stable process group. Ensure the forwarded arguments include `--background` (add it if the user chose background and did not already pass the flag).
- Launch with `Bash` (Claude may still use `run_in_background: true` for the short enqueue call; the long-running work is the bridge `run-worker`):
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-bridge.mjs" review --background "$ARGUMENTS"`,
  description: "Muse Code review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "Muse Code review started in the background. Check `/muse:runs` for progress. Stop with `/muse:stop`."
