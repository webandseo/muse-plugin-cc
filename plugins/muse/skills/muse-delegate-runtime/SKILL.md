---
name: muse-delegate-runtime
description: Internal helper contract for calling the muse-bridge runtime from Claude Code
user-invocable: false
---

# Muse Code Delegate Runtime

Use this skill only inside the `muse:muse-delegate` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-bridge.mjs" run "<raw arguments>"`

Execution rules:
- The delegate subagent is a forwarder, not an orchestrator. Its only job is to invoke `run` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Muse CLI strings, or any other Bash activity.
- Do not call `check`, `review`, `critique`, `runs`, `show`, or `stop` from `muse:muse-delegate`.
- Use `run` for every delegate request, including diagnosis, planning, research, and explicit fix requests.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one. Without `--model` the bridge uses `MUSE_CC_MODEL`, or else `spark` (`muse-spark-1.3`), never Muse's contributor default.
- Default to a write-capable Muse run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `run` invocation per delegate handoff, in one `Bash` call with the Bash tool's `timeout` parameter set to `600000` (the default 120000 is shorter than most Muse runs).
- If that call is moved to the background, times out, or is interrupted, do not call `run` again. The run is still tracked by the bridge, and a second write-capable run would edit the same files concurrently. Return the background notice and the run id the bridge printed (`Tracking this run as run-...`) with `/muse:runs <run-id> --wait` and `/muse:stop <run-id>`, then stop.
- `--wait` and `--background` are Claude-side execution flags; do not treat them as part of the natural-language task text. Never forward `--wait` to `run`; the bridge does not accept it. `--background` is the one the bridge supports: `run --background` queues a detached worker, records `bridgePid` and `agentPid`, and returns the run id at once. Pass it when the user chose background mode or the work is long.
- If the bridge refuses because another write-capable run is still active in this repository, return its message as-is and stop. Add `--allow-concurrent` only when the user explicitly asked for parallel runs.
- If the forwarded request includes `--model`, pass it through to `run`.
- If the forwarded request includes `--effort`, pass it through to `run`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `run --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `run`, even if the request sounds like a follow-up.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`.
- `--model`: real ids (`muse-spark-1.3`, `muse-spark-1.3-contributor`, `muse-spark-1.2`) or the aliases `spark`, `contributor`, `spark-1.2`.
- `--worktree [--worktree-base <ref>]`: run in an isolated git worktree; requires `--write`, not combinable with `--resume-last`. Pass it through, or add it when the user asks for isolation.
- `--image <path>`: attach an image; pass it through unchanged.
- `run --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous delegate run. It continues the same Muse session id, so Muse keeps its prior context.

Safety rules:
- Default to write-capable Muse work in `muse:muse-delegate` unless the user explicitly asks for read-only behavior.
- Write-capable runs give Muse its shell and load the workspace's own skills and rules; read-only runs have no shell and no write access.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, stop runs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `run` command exactly as-is.
- If the Bash call fails or Muse cannot be invoked, return nothing, except for the backgrounded or refused cases above.
