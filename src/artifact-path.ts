import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { CliError } from "./cli-error.js";

/**
 * A path-safe graph identifier still allows ordinary historical identifiers,
 * including spaces and non-ASCII text. The pattern is also published in the
 * graph JSON schema so validation has one contract at both entry points.
 */
export const artifactIdPattern = String.raw`^(?!\s*$)(?!\.{1,2}$)(?!.*[ .]$)(?![cC][oO][nN](?:\..*)?$)(?![pP][rR][nN](?:\..*)?$)(?![aA][uU][xX](?:\..*)?$)(?![nN][uU][lL](?:\..*)?$)(?![cC][oO][nN][iI][nN]\$(?:\..*)?$)(?![cC][oO][nN][oO][uU][tT]\$(?:\..*)?$)(?![cC][lL][oO][cC][kK]\$(?:\..*)?$)(?!(?:[cC][oO][mM]|[lL][pP][tT])[1-9¹²³](?:\..*)?$)[^/\\:\x00-\x1f\x7f<>:"|?*]+$`;

const artifactIdPatternRegex = new RegExp(artifactIdPattern);

export function isSafeArtifactId(value: unknown): value is string {
  return typeof value === "string" && artifactIdPatternRegex.test(value);
}

export function assertSafeArtifactId(value: unknown, label = "run ID"): asserts value is string {
  if (!isSafeArtifactId(value)) {
    throw new CliError(
      `${label} must be a safe single path component without separators, dot segments, control characters, or platform-reserved names`,
      3,
      "INVALID_ARTIFACT_ID",
    );
  }
}

/** Resolve a run's storage directory and keep it within the runs root. */
export function runArtifactDirectory(repositoryRoot: string, runId: string): string {
  assertSafeArtifactId(runId);
  const runsDirectory = resolve(repositoryRoot, ".agent-graph", "runs");
  const runDirectory = resolve(runsDirectory, runId);
  const relativeRunDirectory = relative(runsDirectory, runDirectory);
  if (
    dirname(runDirectory) !== runsDirectory ||
    !relativeRunDirectory ||
    relativeRunDirectory === "." ||
    relativeRunDirectory === ".." ||
    relativeRunDirectory.startsWith(`..${sep}`) ||
    isAbsolute(relativeRunDirectory)
  ) {
    throw new CliError("run ID resolves outside its artifact directory", 3, "INVALID_ARTIFACT_ID");
  }
  return runDirectory;
}
