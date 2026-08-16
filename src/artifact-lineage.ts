import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { sha256 } from "./persistence.js";
import type {
  ArtifactLineageRecord,
  ConsumedArtifactContract,
  ProducedArtifactContract,
} from "./types.js";

export interface ArtifactProducerContext {
  producerNodeId: string;
  producerAttemptId: string;
  planRevisionId: string;
  lineage: string[];
}

export class ArtifactCatalog {
  constructor(
    readonly runDirectory: string,
    readonly repositoryRoot: string,
  ) {}

  async record(contract: ProducedArtifactContract, context: ArtifactProducerContext): Promise<ArtifactLineageRecord> {
    const source = safePath(this.repositoryRoot, contract.path);
    const bytes = await readFile(source).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`produced artifact is missing: ${contract.path}`);
      throw error;
    });
    const digest = sha256(bytes);
    const contentPath = join("artifacts", "sha256", digest.slice(0, 2), digest);
    const absoluteContent = join(this.runDirectory, contentPath);
    await mkdir(join(absoluteContent, ".."), { recursive: true });
    await writeImmutableBytes(absoluteContent, bytes);
    const record: ArtifactLineageRecord = {
      schemaVersion: 1,
      artifactId: `artifact-${digest.slice(0, 24)}`,
      name: contract.name,
      type: contract.type,
      sha256: digest,
      size: bytes.byteLength,
      sourcePath: contract.path.replaceAll("\\", "/"),
      contentPath: contentPath.replaceAll("\\", "/"),
      producerNodeId: context.producerNodeId,
      producerAttemptId: context.producerAttemptId,
      planRevisionId: context.planRevisionId,
      lineage: [...context.lineage],
      recordedAt: new Date().toISOString(),
    };
    const records = join(this.runDirectory, "artifact-records");
    await mkdir(records, { recursive: true });
    const safeName = contract.name.replace(/[^a-zA-Z0-9_.-]/g, "_");
    await writeImmutableText(join(records, `${context.producerAttemptId}-${safeName}-${digest.slice(0, 16)}.json`), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  async verifyConsumption(contract: ConsumedArtifactContract, record: ArtifactLineageRecord): Promise<void> {
    if (record.name !== contract.name) throw new Error(`artifact name mismatch for "${contract.name}"`);
    if (record.type !== contract.type) throw new Error(`artifact type drift for "${contract.name}"`);
    if (record.producerNodeId !== contract.from) throw new Error(`artifact producer drift for "${contract.name}"`);
    const content = await readFile(safePath(this.runDirectory, record.contentPath)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`content-addressed artifact is missing: ${record.contentPath}`);
      throw error;
    });
    if (content.byteLength !== record.size || sha256(content) !== record.sha256) throw new Error(`content-addressed artifact drift for "${contract.name}"`);
    const source = await readFile(safePath(this.repositoryRoot, record.sourcePath)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`source artifact is missing: ${record.sourcePath}`);
      throw error;
    });
    if (source.byteLength !== record.size || sha256(source) !== record.sha256) throw new Error(`source artifact drift for "${contract.name}"`);
  }
}

function safePath(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`artifact path must be relative: ${path}`);
  const absolute = resolve(root, path);
  const rel = relative(resolve(root), absolute);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`artifact path escapes its root: ${path}`);
  }
  return absolute;
}

async function writeImmutableBytes(path: string, bytes: Buffer): Promise<void> {
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!Buffer.from(await readFile(path)).equals(bytes)) throw new Error(`immutable artifact bytes differ: ${path}`);
  }
}

async function writeImmutableText(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== content) throw new Error(`immutable artifact record differs: ${path}`);
  }
}
