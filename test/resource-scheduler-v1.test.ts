import assert from "node:assert/strict";
import test from "node:test";

import { ResourceScheduler } from "../src/resource-scheduler.js";
import type { GraphNodeDefinition } from "../src/types.js";

const node = (id: string, resources: GraphNodeDefinition["resources"], owns: string[] = []): GraphNodeDefinition => ({
  id, type: "agent", executor: "codex", prompt: id, needs: [], owns, checks: [], maxAttempts: 1,
  ...(resources === undefined ? {} : { resources }),
});

test("resource scheduler preserves shared parallelism and serializes exclusive claims", () => {
  const scheduler = new ResourceScheduler({ maxConcurrency: 4, providerConcurrency: { codex: 3 } });
  const readA = scheduler.tryAcquire(node("read-a", [{ name: "database", mode: "shared" }]), "attempt-a");
  const readB = scheduler.tryAcquire(node("read-b", [{ name: "database", mode: "shared" }]), "attempt-b");
  assert.ok(readA && readB);
  assert.equal(scheduler.tryAcquire(node("write", [{ name: "database", mode: "exclusive" }]), "attempt-c"), undefined);
  readA.release();
  assert.equal(scheduler.tryAcquire(node("write", [{ name: "database", mode: "exclusive" }]), "attempt-c"), undefined);
  readB.release();
  assert.ok(scheduler.tryAcquire(node("write", [{ name: "database", mode: "exclusive" }]), "attempt-c"));
});

test("repository writers and provider concurrency are bounded", () => {
  const scheduler = new ResourceScheduler({ maxConcurrency: 3, providerConcurrency: { codex: 1 } });
  const writer = scheduler.tryAcquire(node("writer", [], ["src/**"]), "attempt-w");
  assert.ok(writer);
  assert.equal(scheduler.tryAcquire(node("writer-2", [], ["src/**"]), "attempt-w2"), undefined);
  assert.equal(scheduler.tryAcquire(node("reader", []), "attempt-r"), undefined, "provider limit is also enforced");
  writer.release();
  assert.ok(scheduler.tryAcquire(node("reader", []), "attempt-r"));
});

test("budget accounting fails closed before dispatch", () => {
  const scheduler = new ResourceScheduler({
    maxConcurrency: 2,
    providerConcurrency: { codex: 2 },
    budgets: { maxProviderCalls: 1, maxCostUsd: 0.5, deadlineAt: Date.now() + 10_000 },
  });
  const first = node("first", []);
  first.estimatedCostUsd = 0.4;
  const lease = scheduler.tryAcquire(first, "attempt-1");
  assert.ok(lease);
  lease.release({ accepted: true });
  assert.throws(() => scheduler.tryAcquire(node("second", []), "attempt-2"), /provider-call budget/);
  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.providerCalls, 1);
  assert.equal(snapshot.costUsd, 0.4);
});
