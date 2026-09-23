import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { basename, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

interface ToolUseInput {
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

const fileTools = new Set(["Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep"]);
const standaloneAgrProgressPattern =
  /^[ \t]*agr(?:\.exe|\.cmd|\.ps1)?[ \t]+progress[ \t]+--phase[ \t]+[a-z][a-z0-9_-]{0,31}[ \t]+--message[ \t]+(?:"[\p{L}\p{N} _.,:\/'-]{1,240}"|'[\p{L}\p{N} _.,:\/-]{1,240}')(?:[ \t]+--percent[ \t]+(?:100|[1-9]?\d))?[ \t]*$/iu;
const playwrightPrefix = "mcp__plugin_playwright_playwright__";

export function evaluateClaudexToolUse(
  input: ToolUseInput,
  repositoryRoot: string,
): string | undefined {
  const toolName = input.tool_name ?? "";
  const toolInput = input.tool_input ?? {};
  if (toolName.startsWith(playwrightPrefix)) {
    return evaluatePlaywrightToolUse(toolName.slice(playwrightPrefix.length), toolInput, repositoryRoot);
  }
  if (fileTools.has(toolName)) {
    const pathValue = firstString(
      toolInput.file_path,
      toolInput.path,
      toolInput.notebook_path,
    );
    if (
      pathValue &&
      !isInsideRepository(pathValue, input.cwd ?? repositoryRoot, repositoryRoot) &&
      !(isReadTool(toolName) && isTrustedSkillReference(pathValue, input.cwd ?? repositoryRoot))
    ) {
      return toolName + " denied: path is outside repositoryRoot";
    }
  }

  if (toolName !== "Bash") return undefined;
  const command = typeof toolInput.command === "string" ? toolInput.command : "";
  if (standaloneAgrProgressPattern.test(command)) return undefined;
  return "Bash denied: only a standalone agr progress command is available in this graph node";
}

function evaluatePlaywrightToolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
  repositoryRoot: string,
): string | undefined {
  if (toolName.startsWith("browser_run_code")) {
    return "Playwright browser_run_code is not available in AGR implementation nodes";
  }
  if (toolName === "browser_evaluate") {
    const expression = firstString(toolInput.function, toolInput.expression, toolInput.code) ?? "";
    if (/\b(?:fetch|WebSocket|EventSource)\b|(?:window\s*\.)?location\b|window\s*\.\s*open\b/i.test(expression)) {
      return "Playwright evaluate cannot navigate or start network requests";
    }
  }
  if (toolName === "browser_navigate") {
    const url = typeof toolInput.url === "string" ? toolInput.url : "";
    try {
      const parsed = new URL(url);
      if (
        parsed.protocol !== "about:" &&
        !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
      ) {
        return "Playwright navigation is limited to localhost";
      }
    } catch {
      return "Playwright navigation requires a valid localhost URL";
    }
  }
  if (toolName === "browser_tabs" && toolInput.action === "new" && typeof toolInput.url === "string") {
    try {
      const parsed = new URL(toolInput.url);
      if (parsed.protocol !== "about:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
        return "Playwright navigation is limited to localhost";
      }
    } catch {
      return "Playwright navigation requires a valid localhost URL";
    }
  }
  const filePaths = toolName === "browser_file_upload" && Array.isArray(toolInput.paths)
    ? toolInput.paths.filter((value): value is string => typeof value === "string")
    : toolName === "browser_take_screenshot" && typeof toolInput.filename === "string"
      ? [toolInput.filename]
      : [];
  if (
    filePaths.some((pathValue) => !isInsideRepository(pathValue, repositoryRoot, repositoryRoot))
  ) {
    return "Playwright file path is outside repositoryRoot";
  }
  return undefined;
}

function isReadTool(toolName: string): boolean {
  return toolName === "Read" || toolName === "Glob" || toolName === "Grep";
}

function isTrustedSkillReference(value: string, cwd: string): boolean {
  const candidate = resolvePath(value, cwd);
  return [
    resolve(homedir(), ".claude", "plugins", "cache"),
    resolve(homedir(), ".claude", "skills"),
    resolve(homedir(), ".agents", "skills"),
    resolve(homedir(), ".codex", "skills"),
  ].some((root) => {
    const pathFromRoot = relative(root, candidate);
    return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
  });
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function isInsideRepository(value: string, cwd: string, repositoryRoot: string): boolean {
  const candidate = canonicalPath(resolvePath(value, cwd));
  const root = canonicalPath(resolve(repositoryRoot));
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function resolvePath(value: string, cwd: string): string {
  if (process.platform === "win32" && /^\/[a-zA-Z]\//.test(value)) {
    return resolve(value[1] + ":" + value.slice(2));
  }
  return resolve(cwd, value);
}

function canonicalPath(value: string): string {
  let ancestor = resolve(value);
  const remainder: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    remainder.unshift(basename(ancestor));
    ancestor = parent;
  }
  try {
    ancestor = realpathSync.native(ancestor);
  } catch {
    // The nearest existing ancestor may disappear during evaluation.
  }
  return resolve(ancestor, ...remainder);
}

async function main(): Promise<void> {
  const repositoryRoot = process.argv[2];
  if (!repositoryRoot) {
    process.stderr.write("Claudex guard missing repositoryRoot\n");
    process.exitCode = 2;
    return;
  }
  process.stdin.setEncoding("utf8");
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input: ToolUseInput;
  try {
    input = JSON.parse(raw) as ToolUseInput;
  } catch {
    process.stderr.write("Claudex guard received invalid hook JSON\n");
    process.exitCode = 2;
    return;
  }
  const denial = evaluateClaudexToolUse(input, repositoryRoot);
  if (denial) {
    process.stderr.write(denial + "\n");
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
