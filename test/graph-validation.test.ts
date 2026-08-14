import assert from "node:assert/strict";
import test from "node:test";

import { validateGraph } from "../src/graph.js";
import type { GraphDefinition } from "../src/types.js";

const baseGraph = (): GraphDefinition => ({
  version: 1,
  run: {
    id: "validation-fixture",
    objective: "Exercise graph validation",
    repository: ".",
    maxConcurrency: 2,
  },
  nodes: [
    {
      id: "contract",
      type: "agent",
      executor: "codex",
      prompt: "Define the contract",
      needs: [],
      owns: ["docs/**"],
      checks: [],
      maxAttempts: 1,
    },
    {
      id: "implementation",
      type: "agent",
      executor: "claude",
      prompt: "Implement the contract",
      needs: ["contract"],
      owns: ["src/**"],
      checks: [],
      maxAttempts: 1,
    },
  ],
});

test("validate accepts a well-formed acyclic graph", () => {
  const result = validateGraph(baseGraph());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.topologicalOrder, ["contract", "implementation"]);
});

test("validate rejects missing dependencies and cycles", () => {
  const graph = baseGraph();
  graph.nodes[0]!.needs = ["implementation", "missing"];

  const result = validateGraph(graph);

  assert.match(result.errors.join("\n"), /missing dependency "missing"/);
  assert.match(result.errors.join("\n"), /cycle/i);
});

test("validate rejects overlapping ownership for potentially parallel nodes", () => {
  const graph = baseGraph();
  graph.nodes[1]!.needs = [];
  graph.nodes[0]!.owns = ["src/**"];
  graph.nodes[1]!.owns = ["src/api/**"];

  const result = validateGraph(graph);

  assert.match(
    result.errors.join("\n"),
    /nodes "contract" and "implementation" have overlapping ownership/,
  );
});

test("validate enforces review, gate, and external-action safety contracts", () => {
  const graph = baseGraph();
  graph.nodes = [
    {
      id: "review",
      type: "review",
      executor: "codex",
      prompt: "review",
      needs: [],
      owns: ["src/**"],
      checks: [],
      maxAttempts: 1,
    },
    {
      id: "gate",
      type: "human_gate",
      needs: ["review"],
      owns: [],
      checks: [],
      maxAttempts: 1,
    },
    {
      id: "external",
      type: "external_action",
      needs: ["gate"],
      owns: [],
      checks: [],
      maxAttempts: 1,
    },
  ];

  const errors = validateGraph(graph).errors.join("\n");
  assert.match(errors, /review.*must not declare writable ownership/);
  assert.match(errors, /gate.*requires a target/);
  assert.match(errors, /external.*requires an executor/);
  assert.match(errors, /external.*requires a target/);
});

test("validate accepts Claudex as a first-class executor", () => {
  const graph = baseGraph();
  graph.nodes[0]!.executor = "claudex";

  assert.deepEqual(validateGraph(graph).errors, []);
});

test("validate rejects graph-level model overrides for Claudex", () => {
  const graph = baseGraph();
  graph.nodes[0]!.executor = "claudex";
  graph.nodes[0]!.model = "another-model";

  assert.match(
    validateGraph(graph).errors.join("\n"),
    /Claudex node "contract" cannot override the launcher model/,
  );
});
