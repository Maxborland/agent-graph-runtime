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

test("validate accepts an explicit read-only run advisor", () => {
  const graph = baseGraph();
  graph.run.advisor = {
    executor: "codex",
    model: "gpt-5.6-sol",
    instructions: "Watch architectural boundaries and evidence quality.",
    stopOnBlocker: true,
  };

  assert.deepEqual(validateGraph(graph).errors, []);
});

test("validate rejects unsafe or unknown advisor configuration", () => {
  const graph = baseGraph();
  graph.run.advisor = {
    executor: "claudex",
    model: "override-not-owned-by-agr",
  };
  (graph.run.advisor as unknown as Record<string, unknown>).mode = "executor";

  const errors = validateGraph(graph).errors.join("\n");
  assert.match(errors, /run\.advisor has unknown property "mode"/);
  assert.match(errors, /Claudex advisor cannot override the launcher model/);

  (graph.run.advisor as unknown as Record<string, unknown>).executor = "shell";
  graph.run.advisor.instructions = "x".repeat(4_001);
  assert.match(
    validateGraph(graph).errors.join("\n"),
    /run\.advisor requires a Codex, Claude, or Claudex executor/,
  );
  assert.match(validateGraph(graph).errors.join("\n"), /run\.advisor\.instructions must be at most 4000 characters/);

  graph.run.advisor.executor = "codex";
  graph.run.advisor.model = "";
  assert.match(validateGraph(graph).errors.join("\n"), /run\.advisor\.model must be a non-empty string/);
});

test("validate rejects schema-unknown fields instead of silently ignoring them", () => {
  const graph = baseGraph();
  (graph.run as unknown as Record<string, unknown>).timeoutMS = 500;
  (graph.nodes[0] as unknown as Record<string, unknown>).maxAttempt = 2;
  graph.nodes[0]!.context = { symbols: ["Thing"] };
  (graph.nodes[0]!.context as unknown as Record<string, unknown>).file = "src/thing.ts";

  const errors = validateGraph(graph).errors.join("\n");
  assert.match(errors, /run has unknown property "timeoutMS"/);
  assert.match(errors, /node "contract" has unknown property "maxAttempt"/);
  assert.match(errors, /node "contract" context has unknown property "file"/);
});

test("validate rejects schema-invalid field types without throwing", () => {
  const graph = baseGraph();
  (graph.run as unknown as Record<string, unknown>).codeGraph = "yes";
  (graph.nodes[0] as unknown as Record<string, unknown>).timeoutMs = "soon";
  (graph.nodes[1] as unknown as Record<string, unknown>).needs = "contract";

  const result = validateGraph(graph);
  assert.match(result.errors.join("\n"), /run.codeGraph must be a boolean/);
  assert.match(result.errors.join("\n"), /timeoutMs must be a positive integer/);
  assert.match(result.errors.join("\n"), /needs must be an array/);
  assert.deepEqual(result.topologicalOrder, []);
});

test("validate rejects artifact IDs that cannot safely name storage paths", () => {
  const graph = baseGraph();
  graph.run.id = "../escape";
  graph.nodes[0]!.id = "source/child";

  const errors = validateGraph(graph).errors.join("\n");
  assert.match(errors, /run\.id must be a safe artifact identifier/);
  assert.match(errors, /node at index 0 id must be a safe artifact identifier/);

  graph.run.id = "job search_日本";
  graph.nodes[0]!.id = "source child_日本";
  graph.nodes[1]!.needs = ["source child_日本"];
  assert.deepEqual(validateGraph(graph).errors, []);
});

test("validate rejects shell executors for agent and review nodes", () => {
  for (const type of ["agent", "review"] as const) {
    const graph = baseGraph();
    graph.nodes[0]!.type = type;
    graph.nodes[0]!.executor = "shell";

    assert.match(validateGraph(graph).errors.join("\n"), /require an executor that produces a handoff/);
  }
});

test("validate rejects invalid optional field types on every node type", () => {
  const graph = baseGraph();
  const verify = graph.nodes[0]!;
  verify.type = "verify";
  verify.executor = 0 as never;
  verify.prompt = 7 as never;
  verify.target = false as never;

  const errors = validateGraph(graph).errors.join("\n");
  assert.match(errors, /invalid executor/);
  assert.match(errors, /prompt must be a string/);
  assert.match(errors, /target must be a string/);
});

test("validate does not analyze ownership after an invalid implicitOutputs type", () => {
  const graph = baseGraph();
  graph.nodes[1]!.needs = [];
  (graph.nodes[0] as unknown as Record<string, unknown>).implicitOutputs = 7;

  const result = validateGraph(graph);
  assert.match(result.errors.join("\n"), /implicitOutputs must contain only strings/);
  assert.deepEqual(result.topologicalOrder, []);
});

test("validate does not analyze ownership after non-string ownership patterns", () => {
  const graph = baseGraph();
  graph.nodes[1]!.needs = [];
  (graph.nodes[0] as unknown as Record<string, unknown>).owns = [7];

  const result = validateGraph(graph);
  assert.match(result.errors.join("\n"), /owns must contain only strings/);
  assert.deepEqual(result.topologicalOrder, []);
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

test("validate restricts required model usage to complete Claudex requirements", () => {
  const graph = baseGraph();
  graph.nodes[0]!.requiredModelUsage = [
    { model: "gpt-5.6-luna", provider: "", contextWindow: 0 },
  ];

  let errors = validateGraph(graph).errors.join("\n");
  assert.match(errors, /requiredModelUsage is supported only for Claudex/);
  assert.match(errors, /requires a model, provider, and positive contextWindow/);

  graph.nodes[0]!.executor = "claudex";
  graph.nodes[0]!.requiredModelUsage = [
    { model: "gpt-5.6-luna", provider: "firstParty", contextWindow: 262144 },
  ];
  errors = validateGraph(graph).errors.join("\n");
  assert.equal(errors, "");
});

test("validate rejects model usage requirements on non-dispatched nodes", () => {
  for (const type of ["verify", "human_gate"] as const) {
    const graph = baseGraph();
    const candidate = graph.nodes[0]!;
    candidate.type = type;
    candidate.executor = "claudex";
    candidate.owns = [];
    if (type === "human_gate") candidate.target = "approve:model-proof";
    candidate.requiredModelUsage = [
      { model: "gpt-5.6-luna", provider: "firstParty", contextWindow: 262144 },
    ];

    assert.match(
      validateGraph(graph).errors.join("\n"),
      /requiredModelUsage requires a dispatched Claudex node/,
    );
  }
});
