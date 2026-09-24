---
description: Delegate investigation, an explicit fix request, or follow-up work to the Muse Code delegate subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--worktree] [--image <path>] [--model <model|spark|contributor>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [what Muse should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `muse:muse-delegate` subagent via the `Agent` tool (`subagent_type: "muse:muse-delegate"`), forwarding the raw user request as the prompt.
`muse:muse-delegate` is a subagent, not a skill — do not call `Skill(muse:muse-delegate)` (no such skill) or `Skill(muse:delegate)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Muse's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `muse:muse-delegate` subagent in the background.
- If the request includes `--wait`, run the `muse:muse-delegate` subagent in the foreground.
- If neither flag is present, default to foreground.
- Prefer bridge `--background` for long or open-ended work so the run records both `bridgePid` (Node worker) and `agentPid` (muse child).
- `--background` and `--wait` are execution flags for Claude Code, not part of the natural-language task text. Never forward `--wait` to `run`; the bridge does not accept it. `--background` is the only one the bridge supports, as `run --background` (queue a detached worker, return the run id at once).
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `run` call, but do not treat them as part of the natural-language task text. Model aliases: `spark` → `muse-spark-1.3`, `contributor` → `muse-spark-1.3-contributor`.
- `--worktree` makes Muse work in an isolated git worktree (branch `muse/session-<id>` under `.muse/worktrees/`) instead of the live checkout; the result reports the worktree path and how to diff, merge, or discard it. Preserve it for the forwarded `run` call. Also add it when the user asks for the work to be done "in a worktree", "on a branch", "in isolation", or "without touching my working tree".
- `--image <path>` attaches a screenshot or image to the request (Muse's `--image`). Preserve it for the forwarded `run` call.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Muse, check for a resumable delegate session from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-bridge.mjs" run-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Muse session or start a new one.
- The two choices must be:
  - `Continue current Muse session`
  - `Start a new Muse session`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Muse session (Recommended)` first.
- Otherwise put `Start a new Muse session (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new session, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call, with the Bash tool's `timeout` set to `600000`, to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-bridge.mjs" run ...` and return that command's stdout as-is.
- If that call is moved to the background or times out, the subagent must not call `run` again: the run is still tracked, and the bridge refuses a second write-capable run while one is alive. It returns the background notice and run id, and the user follows up with `/muse:runs <run-id> --wait` or `/muse:stop <run-id>`.
- Return the Muse bridge stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/muse:runs`, fetch `/muse:show`, call `/muse:stop`, summarize output, or do follow-up work of its own.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave the model unset unless the user explicitly asks for one.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `run` command.
- If the helper reports that Muse is missing or unauthenticated, stop and tell the user to run `/muse:check`.
- If the user did not supply a request, ask what Muse should investigate or fix.
