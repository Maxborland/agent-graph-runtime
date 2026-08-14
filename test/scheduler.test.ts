import assert from "node:assert/strict";
import test from "node:test";

import { createInitialState, selectReadyNodes } from "../src/state.js";
import type { GraphDefinition } from "../src/types.js";

const graph: GraphDefinition = {
  version: 1,
  run: {
    id: "scheduler-fixture",
    objective: "Run dependency-ready work",
    repository: ".",
    maxConcurrency: 2,
  },
  nodes: [
    {
      id: "contract",
      type: "agent",
      executor: "codex",
      prompt: "contract",
      needs: [],
      owns: ["docs/**"],
      checks: [],
      maxAttempts: 1,
    },
    {
      id: "api",
      type: "agent",
      executor: "codex",
      prompt: "api",
      needs: ["contract"],
      owns: ["api/**"],
      checks: [],
      maxAttempts: 1,
    },
    {
      id: "web",
      type: "agent",
      executor: "claude",
      prompt: "web",
      needs: ["contract"],
      owns: ["web/**"],
      checks: [],
      maxAttempts: 1,
    },
  ],
};

test("scheduler returns only dependency-ready nodes up to concurrency", () => {
  const state = createInitialState(graph, []);
  assert.deepEqual(selectReadyNodes(graph, state).map((node) => node.id), ["contract"]);

  state.nodes.contract!.status = "accepted";
  assert.deepEqual(selectReadyNodes(graph, state).map((node) => node.id), ["api", "web"]);
});

