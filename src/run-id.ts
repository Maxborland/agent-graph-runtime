import { createHash } from "node:crypto";

const unsafePathCharacterPattern = /[<>:"/\\|?*\u0000-\u001f]/;
const windowsDeviceNamePattern = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function isSafeRunId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value !== "." &&
    value !== ".." &&
    !unsafePathCharacterPattern.test(value) &&
    !/[. ]$/.test(value) &&
    !windowsDeviceNamePattern.test(value);
}

export function assertSafeRunId(value: unknown): string {
  if (!isSafeRunId(value)) {
    throw new Error("run.id must be a safe cross-platform runtime identifier and a single path component");
  }
  return value;
}

export function runtimeGitName(value: unknown): string {
  const id = assertSafeRunId(value);
  const slug = id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 72) || "run";
  return `${slug}-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;
}
