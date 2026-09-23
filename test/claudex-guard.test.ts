import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evaluateClaudexToolUse } from "../src/claudex-guard.js";

const repositoryRoot = process.platform === "win32" ? "E:\\repo" : "/work/repo";

test("Claudex guard confines direct file tools to the repository", () => {
  assert.equal(
    evaluateClaudexToolUse(
      { tool_name: "Read", tool_input: { file_path: repositoryRoot + "/src/app.ts" } },
      repositoryRoot,
    ),
    undefined,
  );
  assert.match(
    evaluateClaudexToolUse(
      {
        tool_name: "Read",
        tool_input: {
          file_path: process.platform === "win32" ? "C:\\Users\\user\\secret.txt" : "/home/user/secret.txt",
        },
      },
      repositoryRoot,
    ) ?? "",
    /outside repositoryRoot/,
  );
});

test("Claudex guard permits read-only installed skill references but not edits", () => {
  const reference = join(
    homedir(),
    ".claude",
    "plugins",
    "cache",
    "publisher",
    "plugin",
    "1.0.0",
    "skills",
    "feature",
    "references",
    "guide.md",
  );
  assert.equal(
    evaluateClaudexToolUse(
      { tool_name: "Read", tool_input: { file_path: reference } },
      repositoryRoot,
    ),
    undefined,
  );
  assert.match(
    evaluateClaudexToolUse(
      { tool_name: "Edit", tool_input: { file_path: reference } },
      repositoryRoot,
    ) ?? "",
    /outside repositoryRoot/,
  );
});

test("Claudex guard denies model-controlled Bash except the progress reporter", () => {
  for (const command of [
    "claude --version",
    "pnpm exec claudex -p test",
    "npx @anthropic-ai/claude-code -p test",
    "npm exec @openai/codex -- test",
    "C:/tools/codex.exe exec test",
    "agr run .agent-graph/graph.json",
    "node -e \"require('child_process').spawn('cl'+'aude')\"",
    "node -e \"require('child_process').spawn('co'+String.fromCharCode(100)+'ex')\"",
    "git push origin HEAD",
    "curl -X POST https://example.com/deploy",
    "npm publish",
    "fly deploy",
    "gh pr create --fill",
    "pnpm test",
    "Get-Command pnpm -All",
    "tasklist.exe /FI \"PID eq 42060\"",
    "curl -sS http://127.0.0.1:3140/health",
    // These substitutions must remain denied inside either quoting style, including Windows forms.
    'agr progress --phase verify --message "$(touch /tmp/agr-guard-substitution)"',
    'agr progress --phase verify --message "`touch /tmp/agr-guard-backtick`"',
    'agr progress --phase verify --message "$(Write-Output dangerous)"',
    'agr progress --phase verify --message "%COMSPEC%"',
    "agr progress --phase verify --message '!PATH!'",
  ]) {
    assert.match(
      evaluateClaudexToolUse(
        { tool_name: "Bash", tool_input: { command } },
        repositoryRoot,
      ) ?? "",
      /only a standalone agr progress command/,
    );
  }
});

test("Claudex guard constrains pre-authorized Playwright tools", () => {
  const prefix = "mcp__plugin_playwright_playwright__";
  assert.match(
    evaluateClaudexToolUse(
      { tool_name: prefix + "browser_run_code", tool_input: { code: "process.exit()" } },
      repositoryRoot,
    ) ?? "",
    /not available/,
  );
  assert.match(
    evaluateClaudexToolUse(
      { tool_name: prefix + "browser_run_code_unsafe", tool_input: { code: "process.exit()" } },
      repositoryRoot,
    ) ?? "",
    /not available/,
  );
  assert.match(
    evaluateClaudexToolUse(
      {
        tool_name: prefix + "browser_file_upload",
        tool_input: {
          paths: [process.platform === "win32" ? "C:\\Users\\user\\secret.txt" : "/home/user/secret.txt"],
        },
      },
      repositoryRoot,
    ) ?? "",
    /outside repositoryRoot/,
  );
  assert.match(
    evaluateClaudexToolUse(
      { tool_name: prefix + "browser_navigate", tool_input: { url: "https://example.com" } },
      repositoryRoot,
    ) ?? "",
    /localhost/,
  );
  assert.match(
    evaluateClaudexToolUse(
      {
        tool_name: prefix + "browser_evaluate",
        tool_input: { function: "async () => fetch('https://example.com')" },
      },
      repositoryRoot,
    ) ?? "",
    /network requests/,
  );
  assert.match(
    evaluateClaudexToolUse(
      {
        tool_name: prefix + "browser_tabs",
        tool_input: { action: "new", url: "https://example.com" },
      },
      repositoryRoot,
    ) ?? "",
    /localhost/,
  );
  assert.equal(
    evaluateClaudexToolUse(
      { tool_name: prefix + "browser_navigate", tool_input: { url: "http://127.0.0.1:3100" } },
      repositoryRoot,
    ),
    undefined,
  );
});

test("Claudex guard permits only a standalone AGR progress reporter command", () => {
  for (const command of [
    'agr progress --phase verify --message "live Claudex progress channel works" --percent 100',
    "agr progress --phase verify --message 'live Claudex progress channel works' --percent 100",
    'agr progress --phase verify --message "прогресс, all clear: 100 points" --percent 100',
  ]) {
    assert.equal(
      evaluateClaudexToolUse(
        { tool_name: "Bash", tool_input: { command } },
        repositoryRoot,
      ),
      undefined,
    );
  }
  assert.match(
    evaluateClaudexToolUse(
      {
        tool_name: "Bash",
        tool_input: {
          command: "agr progress --phase verify --message \"done\" --percent 100; codex exec dangerous",
        },
      },
      repositoryRoot,
    ) ?? "",
    /only a standalone agr progress command/,
  );
});
