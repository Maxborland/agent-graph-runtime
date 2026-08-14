import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GraphNodeDefinition } from "./types.js";

const exec = promisify(execFile);

export interface CodeContextResult {
  available: boolean;
  text: string;
  sources: string[];
}

export async function buildCodeContext(
  node: GraphNodeDefinition,
  repositoryRoot: string,
  codeGraphCommand = "codegraph",
): Promise<CodeContextResult> {
  if (!node.context) return { available: false, text: "", sources: [] };
  try {
    const status = await run(codeGraphCommand, ["status", repositoryRoot, "--json"]);
    const stale = /"(?:stale|needsSync)"\s*:\s*true/i.test(status);
    if (stale) {
      return {
        available: false,
        text: "CodeGraph index reports stale state; use targeted repository inspection instead.",
        sources: [],
      };
    }

    const sections: string[] = [];
    const sources: string[] = ["codegraph:status"];
    for (const symbol of node.context.symbols ?? []) {
      sections.push(`Symbol ${symbol}:\n${await run(codeGraphCommand, ["query", symbol, "-p", repositoryRoot, "-j"])}`);
      sources.push(`codegraph:query:${symbol}`);
    }
    for (const symbol of node.context.impact ?? []) {
      sections.push(`Impact ${symbol}:\n${await run(codeGraphCommand, ["impact", symbol, "-p", repositoryRoot, "-j"])}`);
      sources.push(`codegraph:impact:${symbol}`);
    }
    if ((node.context.affectedFiles?.length ?? 0) > 0) {
      sections.push(
        `Affected tests:\n${await run(codeGraphCommand, [
          "affected",
          ...(node.context.affectedFiles ?? []),
          "-p",
          repositoryRoot,
          "-j",
        ])}`,
      );
      sources.push("codegraph:affected");
    }
    return {
      available: true,
      text: sections.join("\n\n").slice(0, 60_000),
      sources,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      text: `CodeGraph unavailable (${message.slice(0, 300)}); use targeted repository inspection instead.`,
      sources: [],
    };
  }
}

async function run(command: string, args: string[]): Promise<string> {
  const { stdout } = await exec(command, args, {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout.trim();
}

