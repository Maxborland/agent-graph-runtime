import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { sha256 } from "./persistence.js";
import type { RunState } from "./types.js";

export async function verifyRunEvidenceArtifacts(runDirectory: string, state: RunState): Promise<void> {
  for (const attempt of Object.values(state.attempts).filter((item) => item.status === "accepted")) {
    for (const artifact of attempt.evidence) {
      if (artifact.producerAttemptId !== attempt.attemptId) {
        throw new Error(`evidence artifact ${artifact.artifactId} has an invalid producer`);
      }
      await verifyArtifact(runDirectory, artifact.artifactId, artifact.localPath, artifact.sha256, artifact.size);
    }
  }
  for (const record of state.authority.reconciliations) {
    await verifyArtifact(
      runDirectory,
      record.reconciliationId,
      record.localPath,
      record.sha256,
      record.size,
    );
  }
}

async function verifyArtifact(
  runDirectory: string,
  artifactId: string,
  localPath: string,
  expectedSha256: string,
  expectedSize: number,
): Promise<void> {
  if (isAbsolute(localPath)) throw new Error(`evidence artifact ${artifactId} has an invalid path`);
  const path = resolve(runDirectory, localPath);
  const contained = relative(runDirectory, path);
  if (contained === "" || contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
    throw new Error(`evidence artifact ${artifactId} escapes the run directory`);
  }
  const content = await readFile(path);
  if (content.byteLength !== expectedSize || sha256(content) !== expectedSha256) {
    throw new Error(`evidence artifact ${artifactId} failed byte-level integrity verification`);
  }
}
