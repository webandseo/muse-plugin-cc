import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "muse");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("command set is complete", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "check.md",
    "critique.md",
    "delegate.md",
    "review.md",
    "runs.md",
    "show.md",
    "stop.md",
    "sync-skills.md",
    "transfer.md"
  ]);
});

test("plugin surfaces use /muse names and the muse bridge, never codex or grok", () => {
  const files = [
    "commands/check.md",
    "commands/review.md",
    "commands/critique.md",
    "commands/delegate.md",
    "commands/runs.md",
    "commands/show.md",
    "commands/stop.md",
    "commands/transfer.md",
    "commands/sync-skills.md",
    "agents/muse-delegate.md",
    "hooks/hooks.json",
    "skills/muse-delegate-runtime/SKILL.md",
    "skills/muse-run-output/SKILL.md",
    "skills/muse-spark-prompting/SKILL.md",
    "prompts/critique.md",
    "prompts/stop-review-gate.md",
    "prompts/transfer.md",
    "scripts/muse-bridge.mjs"
  ];

  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, /\bcodex\b/i, `${file} should not mention codex`);
    assert.doesNotMatch(source, /\bgrok\b/i, `${file} should not mention grok`);
  }

  const bridge = read("scripts/muse-bridge.mjs");
  assert.match(bridge, /muse-bridge/);
  assert.match(bridge, /getMuseAvailability/);
  assert.match(bridge, /enable-review-gate/);

  const review = read("commands/review.md");
  assert.match(review, /\/muse:review/);
  assert.match(review, /muse-bridge\.mjs" review/);
  assert.match(review, /AskUserQuestion/);
  assert.match(review, /run_in_background:\s*true/);
  assert.match(review, /review --background/);
  assert.match(review, /Do not fix issues/i);
  assert.match(review, /return Muse's output verbatim to the user/i);
  assert.match(review, /\(Recommended\)/);
  assert.match(review, /--model <model>/);
  assert.match(review, /--effort <none\|minimal\|low\|medium\|high\|xhigh\|max\|ultra>/);

  const critique = read("commands/critique.md");
  assert.match(critique, /\/muse:critique/);
  assert.match(critique, /critique --background/);
  assert.match(critique, /uses the same review target selection as `\/muse:review`/i);
  assert.match(critique, /can still take extra focus text after the flags/i);

  const delegate = read("commands/delegate.md");
  assert.match(delegate, /subagent_type: "muse:muse-delegate"/);
  assert.match(delegate, /do not call `Skill\(muse:muse-delegate\)`/i);
  assert.doesNotMatch(delegate, /^context:\s*fork\b/m);
  assert.match(delegate, /run-resume-candidate --json/);
  assert.match(delegate, /Continue current Muse session/);
  assert.match(delegate, /Start a new Muse session/);

  const agent = read("agents/muse-delegate.md");
  assert.match(agent, /muse-bridge\.mjs" run/);
  assert.match(agent, /--resume-last/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /^name: muse-delegate$/m);

  const hooks = JSON.parse(read("hooks/hooks.json"));
  assert.ok(hooks.hooks.SessionStart);
  assert.ok(hooks.hooks.SessionEnd);
  assert.ok(hooks.hooks.Stop);
  assert.match(JSON.stringify(hooks), /session-lifecycle-hook\.mjs/);
  assert.match(JSON.stringify(hooks), /stop-review-gate-hook\.mjs/);

  const transfer = read("commands/transfer.md");
  assert.match(transfer, /muse resume <session-id>/);
  assert.match(transfer, /muse-bridge\.mjs" transfer/);

  const check = read("commands/check.md");
  assert.match(check, /muse-bridge\.mjs" check --json/);
  assert.match(check, /enable-review-gate/);

  assert.match(delegate, /--worktree/);
  assert.match(delegate, /--image/);
  assert.match(agent, /--worktree/);

  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  for (const command of ["check", "review", "critique", "delegate", "transfer", "sync-skills", "runs", "show", "stop"]) {
    assert.match(readme, new RegExp(`### \`/muse:${command}\``));
  }
  assert.match(readme, /plugin marketplace add webandseo\/muse-plugin-cc/);
  assert.match(readme, /plugin install muse@webandseo-muse/);
  assert.doesNotMatch(readme, /meta-muse-code/, "no install instruction may use the upstream marketplace name");
  assert.match(readme, /fork of \[rtravellin\/muse-code-plugin-cc\]\(https:\/\/github\.com\/rtravellin\/muse-code-plugin-cc\)/);
  assert.match(readme, /^## Windows$/m);
});

test("runtime skill only forwards run once and output skill forbids auto-fixing", () => {
  const runtimeSkill = read("skills/muse-delegate-runtime/SKILL.md");
  assert.match(runtimeSkill, /muse-bridge\.mjs" run "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `run` for every delegate request/i);
  assert.match(runtimeSkill, /run --resume-last/i);
  assert.match(runtimeSkill, /Do not call `check`, `review`, `critique`, `runs`, `show`, or `stop`/);
  assert.match(runtimeSkill, /natural-language task text/);

  const resultHandling = read("skills/muse-run-output/SKILL.md");
  assert.match(resultHandling, /do not turn a failed or incomplete Muse run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Muse was never successfully invoked, do not generate a substitute answer at all/i);
  assert.match(resultHandling, /Auto-applying fixes from a review is strictly forbidden/);
});

test("delegate forwarding uses a long Bash timeout, never re-runs run, and keeps --wait on the Claude side", () => {
  const surfaces = {
    agent: read("agents/muse-delegate.md"),
    runtimeSkill: read("skills/muse-delegate-runtime/SKILL.md"),
    delegate: read("commands/delegate.md")
  };
  for (const [name, source] of Object.entries(surfaces)) {
    assert.match(source, /`timeout`[^\n]*`600000`/, `${name} must set the Bash tool timeout to 600000`);
    assert.match(source, /moved to the background[^\n]*(do|must) not call `run` again/i, `${name} must forbid a second run call`);
    assert.match(source, /never forward `--wait` to `run`/i, `${name} must keep --wait Claude-side`);
    assert.match(source, /`run --background`/, `${name} must name the bridge's own --background`);
  }
  for (const [name, source] of Object.entries({ agent: surfaces.agent, runtimeSkill: surfaces.runtimeSkill })) {
    assert.match(source, /another write-capable run is still active/i, `${name} must explain the bridge refusal`);
  }
  assert.doesNotMatch(surfaces.delegate, /Do not forward them to `run`/, "delegate.md must not forbid bridge --background");
});

test("manifests agree on the plugin name and version", () => {
  const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(plugin.name, "muse");
  assert.equal(marketplace.name, "webandseo-muse");
  assert.equal(marketplace.owner.name, "webandseo");
  const entry = marketplace.plugins.find((item) => item.name === "muse");
  assert.equal(entry.source, "./plugins/muse");
  assert.equal(entry.version, plugin.version);
  assert.equal(marketplace.metadata.version, plugin.version);
  assert.equal(pkg.version, plugin.version);
});

test("prompt templates only reference known placeholders", () => {
  const known = new Set([
    "TARGET_LABEL",
    "USER_FOCUS",
    "REVIEW_COLLECTION_GUIDANCE",
    "REVIEW_INPUT",
    "REVIEW_KIND",
    "CLAUDE_RESPONSE_BLOCK",
    "REPO_ROOT",
    "TURN_COUNT",
    "TRANSCRIPT",
    "TRANSCRIPT_PATH",
    "CLAUDE_SESSION_ID"
  ]);
  for (const name of ["critique", "stop-review-gate", "transfer", "transfer-native"]) {
    const source = read(`prompts/${name}.md`);
    for (const match of source.matchAll(/\{\{([A-Z_]+)\}\}/g)) {
      assert.ok(known.has(match[1]), `${name}.md uses unknown placeholder ${match[1]}`);
    }
  }
});
