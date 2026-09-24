# Muse Code plugin for Claude Code

Use Meta's [Muse Code](https://developer.meta.com/ai/products/muse-code/) from inside Claude Code: ask it for a review, hand it a task, or move a Claude session over to it.

Reviews and delegated work run as background jobs you can check on, stop, or resume, so a long Muse run does not hold up the Claude session that started it.

![Animated transcript of /muse:check, /muse:review, /muse:delegate --worktree, --resume, background runs, /muse:stop and /muse:transfer against Muse Code 1.3](docs/demo.svg)

<sub>The demo is one real session against Muse Code 1.3.0, captured command by command into `docs/demo-captures/`. The repository path and home directory are substituted when the demo is built, and the login email is redacted in the capture files. `npm run build-demo-script` turns the captures into `docs/demo-script.json` and `npm run render-demo` draws it.</sub>

Everything these commands send (diffs, prompts, transcripts) goes to Meta's hosted model through your Muse login, the same as when you run Muse yourself.

## Commands

- `/muse:review`: read-only review of your working tree or branch
- `/muse:critique`: a harsher review of the design, with findings returned as structured JSON
- `/muse:delegate`: hand a task to Muse through the `muse:muse-delegate` subagent, which Claude may also reach for on its own when a debugging or implementation job is large
- `/muse:transfer`: continue the current Claude session in Muse
- `/muse:runs`, `/muse:show`, `/muse:stop`: background runs
- `/muse:check`: setup check; also switches the stop-time review gate on or off
- `/muse:sync-skills`: import your Claude Code skills into Muse

Some of this comes straight from Muse rather than from the bridge: `--worktree` delegation, `--image` attachments, and critique findings that Muse enforces with `--output-schema`. Session transfer uses Muse's bundled `resume-claude` skill.

## Requirements

- Muse Code, installed and logged in (`muse login` or `META_API_KEY`). Runs count against your Muse usage.
- Node.js 20 or later on the machine running Claude Code (CI runs 20 and 22).
- Git on `PATH`.

Muse installs with `curl https://dev.meta.ai/install.sh | bash` on macOS and Linux, or `irm https://dev.meta.ai/install.ps1 | iex` on Windows. The plugin runs `muse` where Claude Code runs; if you keep Muse inside WSL, run Claude Code there too (see [Windows](#windows)).

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add rtravellin/muse-code-plugin-cc
```

Install the plugin:

```bash
/plugin install muse@meta-muse-code
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/muse:check
```

### Local install (from a clone)

From this repository root (the path must be absolute):

```bash
claude plugin marketplace add /absolute/path/to/muse-code-plugin-cc
claude plugin install muse@meta-muse-code
```

Or, with Claude Code already open, use `/plugin`, add the local marketplace path, then install `muse@meta-muse-code`.

After install you should see the slash commands below and the `muse:muse-delegate` subagent in `/agents`.

A simple first run:

```bash
/muse:review --background
/muse:runs
/muse:show
```

## Usage

### `/muse:check`

Checks Node, the `muse` binary, authentication, the model catalog, and Git.

```text
/muse:check
/muse:check --probe
/muse:check --enable-review-gate
/muse:check --disable-review-gate
```

`--probe` makes a one-step model call to confirm the login works. The review-gate flags control the `Stop` hook described under [Review gate](#review-gate). The models line lists what Muse's catalog offers and which model is the default. Meta's default, `muse-spark-1.3-contributor`, carries a catalog note saying your content may be used for product improvement; `--model spark` on any command picks `muse-spark-1.3`, which has no such note.

### `/muse:review`

Reviews your uncommitted changes, or your branch against a base with `--base <ref>`.

```text
/muse:review
/muse:review --base main
/muse:review --background
/muse:review --wait --model muse-spark-1.3 --effort high
```

The review runs `muse exec` with the shell and file writes disabled, so Muse can read the repository but not change it. The diff goes into the prompt up to 40 files or 512 KB; above that Muse gets the file list and reads what it needs. `--model` and `--effort` are optional and default to Muse's own `settings.json`. Efforts: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`.

> [!NOTE]
> A review of several files takes a few minutes. Run it in the background, then use `/muse:runs` and `/muse:show`.

### `/muse:critique`

A review that argues against the change: the design choices, the tradeoffs, and the ways it could fail. It takes the same targets as `/muse:review` plus focus text after the flags, and returns a verdict, findings with file and line ranges ordered by severity, and next steps.

```text
/muse:critique
/muse:critique --base main challenge whether this was the right caching and retry design
/muse:critique --background look for race conditions and question the chosen approach
```

Muse produces the findings under `--output-schema`, so the JSON is enforced by Muse and never has to be parsed out of prose.

### `/muse:delegate`

Hands a task to Muse through the `muse:muse-delegate` subagent.

```text
/muse:delegate investigate why the tests started failing
/muse:delegate fix the failing test with the smallest safe patch
/muse:delegate --resume apply the top fix from the last run
/muse:delegate --model spark --effort medium investigate the flaky integration test
/muse:delegate --background investigate the regression
/muse:delegate --worktree rewrite the retry layer without touching my working tree
/muse:delegate --image ./bug.png the layout breaks like this on mobile, find the cause
```

You can also just ask:

```text
Ask Muse to redesign the database connection to be more resilient.
```

- Delegate runs can write by default: Muse gets its shell, edits files, and loads the workspace's own skills and rules (`--trust-workspace`). Say so if you only want a diagnosis and no edits.
- `--resume` continues the last delegate run's Muse session (`muse exec --session-id <id>`), so Muse still has its context. `--fresh` starts a new session. With neither, the plugin asks whether to continue the latest run from this Claude session.
- `--worktree` runs Muse in its own git worktree: the bridge runs `git worktree add` for a branch named `muse/session-<id>` under `.muse/worktrees/`, hands it to Muse, and leaves it in place afterwards. Your checkout is untouched. The result prints the worktree path and the `diff`, `merge`, and discard commands for it. `--worktree-base <ref>` branches from something other than `HEAD`.
- `--image <path>` attaches a screenshot or other image.
- One write-capable delegate run at a time per repository: while one is still alive, a second is refused with the run id to follow (`/muse:runs <id> --wait`) or stop (`/muse:stop <id>`). A record whose processes have died is marked failed instead of blocking. `--allow-concurrent` starts a second one anyway.
- `--model` takes a catalog id or one of the aliases `spark` (`muse-spark-1.3`), `contributor` (`muse-spark-1.3-contributor`), and `spark-1.2`.
- Every finished delegate run ends with a `muse resume <session-id>` line so you can pick the session up in Muse's own TUI; `/muse:runs` and `/muse:show` print it for reviews too.

### `/muse:transfer`

Starts a Muse session that continues the current Claude Code conversation, and prints the `muse resume <session-id>` command.

```text
/muse:transfer
/muse:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
/muse:transfer --model spark --effort medium
```

The `SessionStart` hook records the current transcript path, so you rarely need `--source`. The bridge asks Muse to read the transcript with its bundled `resume-claude` skill, the same importer Muse uses for its own `/import`, so Muse works from the raw Claude Code JSONL. If that does not complete, or if you pass `--condensed`, the bridge instead seeds the session with a condensed transcript: thinking blocks dropped, tool calls reduced to one-line notes, oldest turns trimmed once the text passes 200 KB. Either way Muse answers with a short handoff note and the session is yours to continue. The source file must be under `~/.claude/projects`. `--model` (catalog id or alias) and `--effort` apply to the import turn and to the fallback; the effort defaults to `low` for transfers.

### `/muse:sync-skills`

Imports the skills in `~/.claude/skills` into Muse as user skills, using `muse skills import --from claude`.

```text
/muse:sync-skills --dry-run
/muse:sync-skills
/muse:sync-skills --force
```

Muse reads the skills directory of the user it runs as.

### `/muse:runs`

Shows running and recent Muse runs for the current repository.

```text
/muse:runs
/muse:runs run-abc123
/muse:runs run-abc123 --wait
```

### `/muse:show`

Shows the stored output of a finished run, including the Muse session ID.

```text
/muse:show
/muse:show run-abc123
```

### `/muse:stop`

Stops a background run by terminating the bridge worker and the `muse` process tree.

```text
/muse:stop
/muse:stop run-abc123
```

## Review gate

`/muse:check --enable-review-gate` adds a `Stop` hook that runs a read-only Muse review of Claude's previous turn. If Muse finds something that still needs fixing, the stop is blocked and Claude gets the findings first.

> [!WARNING]
> The gate can keep Claude and Muse going back and forth for a long time and burn through usage limits. Enable it only for sessions you are watching. `/muse:check --disable-review-gate` turns it off.

## Common flows

Review before shipping:

```bash
/muse:review
```

Hand a problem to Muse:

```bash
/muse:delegate investigate why the build is failing in CI
```

Start something long, then check in:

```bash
/muse:critique --background
/muse:delegate --background investigate the flaky test
/muse:runs
/muse:show
```

## How it talks to Muse

The plugin runs your local Muse install's headless mode, `muse exec --json`, with the same configuration Muse uses on its own (`~/.config/muse/settings.json`, workspace rules and skills). There is no separate runtime or account.

Each run:

- writes the prompt to a temp file and passes `--prompt-file`, so prompts never go through shell quoting;
- passes `--disable-approval --user-input-auto-resolve`, because nobody is there to answer prompts; the read-only flags are what keep a review from changing anything;
- passes `--no-foreign-personal-context`, so Muse does not load your own `~/.claude` skills and personal rules into runs made for Claude Code (without it they go to Meta with every prompt); `MUSE_CC_FOREIGN_CONTEXT=1` turns this off;
- sets a `--session-id`, which is what `--resume` and `muse resume` rely on;
- writes Muse's JSONL events to a per-run log, which is where `/muse:runs` gets the phase (thinking, reading files, running a command, editing, verifying).

| Run kind | Shell | Writes | Web tools | Workspace skills/rules | Worktree |
| --- | --- | --- | --- | --- | --- |
| `review` / `critique` | no | no | no | no | no |
| `delegate` (default, write-capable) | yes | yes | yes | yes | with `--worktree` |
| `delegate` read-only | no | no | yes | yes | no |
| stop-gate review | no | no | no | no | no |
| `transfer` import turn | no | no | no | yes | no |

## What it does and does not do

| | |
| --- | --- |
| Read-only review | bridge prompt with shell and writes off; Muse has no built-in review command |
| Adversarial critique | same, with findings enforced by Muse (`--output-schema`) |
| Delegate with resume | `muse exec --session-id`, so a follow-up continues the same Muse session |
| Isolated worktree delegation | `--worktree`, on a `muse/session-<id>` branch |
| Image attachments | `--image` |
| Background runs, status, result, stop | plugin-owned jobs, one `muse exec` per run, no broker process |
| Session transfer | Muse's `resume-claude` skill, with a condensed-transcript fallback |
| Skills sync from Claude Code | `/muse:sync-skills` |
| Stop-time review gate | optional `Stop` hook |

Two limits worth knowing before you rely on it. Reviews are a prompt the bridge sends, not a reviewer Muse ships, so their shape depends on the model rather than on a fixed command. And Muse's cross-session messaging refuses headless runs (`external_agent_ingress_closed`), so there is no way to redirect a turn while it is running; `/muse:stop` ends the process instead.

To change the default model or effort, edit Muse's `settings.json` (`model`, `reasoning_effort`). The plugin only overrides them when you pass `--model` or `--effort`.

## Windows

Meta's PowerShell installer puts a `muse` batch shim in `%LOCALAPPDATA%\Programs\muse` next to `muse-bin-<version>.exe`. The bridge runs the exe directly instead of going through `cmd.exe` and PowerShell. Two things about the Windows build of Muse 1.3.0 are worth knowing:

- Its shell tool runs inside an OS sandbox that needs a one-time elevated setup: `muse sandbox windows setup` from an administrator PowerShell. Until then reviews work, since they never use the shell, but delegate runs cannot run commands and Muse reports `sandbox enforcement unavailable`. `/muse:check` shows the state. If you would rather skip the setup, `MUSE_CC_DISABLE_SANDBOX=1` makes write-capable delegate runs pass `--disable-sandbox`. The bridge never does that by itself.
- It prints some paths without a drive letter or with a `\\?\` prefix; the bridge fixes them so file links work.

If your Muse lives inside WSL, run Claude Code inside WSL as well (the `claude` CLI in a WSL terminal) and the plugin behaves exactly as on Linux. It does not bridge from a Windows session into WSL.

## Environment

| Variable | Purpose |
| --- | --- |
| `MUSE_BINARY` | Override for the `muse` executable |
| `META_API_KEY` | Muse API key; takes priority over the `muse login` account |
| `MUSE_CC_DISABLE_SANDBOX` | `1` passes `--disable-sandbox` to write-capable delegate runs on Windows (opt-in; see above) |
| `MUSE_CC_FOREIGN_CONTEXT` | `1` stops passing `--no-foreign-personal-context`, so Muse loads your `~/.claude` skills and personal rules into bridge runs again (opt-out; off by default) |
| `MUSE_CC_SESSION_ID` | Claude session id (set by the `SessionStart` hook) |
| `MUSE_CC_TRANSCRIPT_PATH` | Claude transcript path (set by the `SessionStart` hook) |
| `CLAUDE_PLUGIN_ROOT` | Plugin install root (host) |
| `CLAUDE_PLUGIN_DATA` | Plugin data root; run state lives under `.../state` |
| `CLAUDE_ENV_FILE` | Host env file for session hooks |
| `CLAUDE_PROJECT_DIR` | Project directory from the host |

When `CLAUDE_PLUGIN_DATA` is unset, state goes to `$TMPDIR/muse-cc-runs`.

## FAQ

### Do I need a separate Muse account for this plugin?

No. The plugin uses your local Muse Code CLI and its stored login. If you have never used Muse, install it and run `muse login` for a Meta account or `muse auth set --api-key-stdin` for an API key.

### Does the plugin use a separate Muse runtime?

No. It runs the same `muse` binary you use interactively, with the same settings and session store in the same checkout, which is why `muse resume <session-id>` works on anything the plugin ran.

### Why do reviews say "no shell"?

Reviews run with `--disable-shell --disable-write`, so Muse cannot run commands or modify files, only read the repository. That keeps `/muse:review` and `/muse:critique` read-only. Delegate runs get the shell.

## Development

```bash
npm test
```

Tests use Node's built-in test runner and a fake `muse` that emits the same JSONL event stream as the real CLI. Runtime code uses the Node standard library only.

## License

Apache-2.0. See `LICENSE` and `NOTICE`. This is a community project and is not affiliated with Meta or Anthropic.
