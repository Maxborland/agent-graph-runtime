import assert from "node:assert/strict";
import test from "node:test";

import { buildCodeContext } from "../src/context.js";
import type { GraphNodeDefinition } from "../src/types.js";

test("missing CodeGraph returns an explicit fallback instead of fabricated context", async () => {
  const node: GraphNodeDefinition = {
    id: "context",
    type: "agent",
    executor: "codex",
    prompt: "inspect billing",
    needs: [],
    owns: ["src/**"],
    checks: [],
    maxAttempts: 1,
    context: { symbols: ["BillingService"], impact: ["createPayment"] },
  };

  const context = await buildCodeContext(node, process.cwd(), "definitely-not-codegraph");

  assert.equal(context.available, false);
  assert.match(context.text, /CodeGraph unavailable/);
  assert.deepEqual(context.sources, []);
});

