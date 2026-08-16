import assert from "node:assert/strict";
import test from "node:test";

import { RunLifecycle } from "../src/lifecycle.js";
import { createInitialState } from "../src/state.js";
import type { GraphDefinition } from "../src/types.js";

const gateGraph = (): GraphDefinition => ({
  version: 1,
  run: { id: "lifecycle-gate", objective: "Control lifecycle transitions", repository: ".", maxConcurrency: 1 },
  nodes: [{
    id: "release",
    type: "human_gate",
    target: "deploy:production",
    needs: [],
    owns: [],
    checks: [],
    maxAttempts: 1,
  }],
});

test("lifecycle records only an exact dependency-ready gate approval", () => {
  const graph = gateGraph();
  const state = createInitialState(graph, []);
  const lifecycle = new RunLifecycle(graph, state);

  assert.throws(() => lifecycle.approveGate("release", "deploy:staging"), /does not match/);
  assert.equal(state.nodes.release!.approvedTarget, undefined);

  const event = lifecycle.approveGate("release", "deploy:production");
  assert.equal(state.status, "running");
  assert.equal(state.nodes.release!.status, "pending");
  assert.equal(state.nodes.release!.approvedTarget, "deploy:production");
  assert.deepEqual(event, {
    type: "approval_recorded",
    nodeId: "release",
    detail: "deploy:production",
  });
});

test("lifecycle retry invalidates the selected node and every descendant", () => {
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "lifecycle-retry", objective: "Invalidate descendants", repository: ".", maxConcurrency: 1 },
    nodes: [
      { id: "a", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1 },
      { id: "b", type: "verify", needs: ["a"], owns: [], checks: [], maxAttempts: 1 },
      { id: "other", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1 },
    ],
  };
  const state = createInitialState(graph, []);
  for (const id of ["a", "b", "other"]) {
    state.nodes[id]!.status = "accepted";
    state.nodes[id]!.attempts = 1;
    state.nodes[id]!.retryBlocked = true;
    state.nodes[id]!.evidenceFiles = [`evidence/${id}.json`];
  }

  const events = new RunLifecycle(graph, state).retryFrom("a");

  assert.deepEqual(events.map((event) => event.nodeId).sort(), ["a", "b"]);
  for (const id of ["a", "b"]) {
    assert.equal(state.nodes[id]!.status, "pending");
    assert.equal(state.nodes[id]!.attempts, 0);
    assert.equal(state.nodes[id]!.retryBlocked, undefined);
    assert.deepEqual(state.nodes[id]!.evidenceFiles, []);
  }
  assert.equal(state.nodes.other!.status, "accepted");
  assert.equal(state.status, "running");
});

test("lifecycle advances dependency-ready nodes to a completed terminal decision", () => {
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "lifecycle-complete", objective: "Advance a run", repository: ".", maxConcurrency: 1 },
    nodes: [
      { id: "first", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1 },
      { id: "second", type: "verify", needs: ["first"], owns: [], checks: [], maxAttempts: 1 },
    ],
  };
  const state = createInitialState(graph, []);
  const lifecycle = new RunLifecycle(graph, state);

  assert.deepEqual(lifecycle.readyNodes().map((node) => node.id), ["first"]);
  assert.deepEqual(lifecycle.startNode("first"), { type: "node_started", nodeId: "first", detail: "attempt 1" });
  assert.equal(state.nodes.first!.attempts, 1);
  assert.deepEqual(lifecycle.acceptNode("first"), { type: "node_accepted", nodeId: "first" });
  assert.deepEqual(lifecycle.readyNodes().map((node) => node.id), ["second"]);
  lifecycle.startNode("second");
  lifecycle.acceptNode("second");

  assert.deepEqual(lifecycle.finishWhenIdle(), { type: "run_completed" });
  assert.equal(state.status, "completed");
});

test("lifecycle maps a retry-blocked node failure to operator attention", () => {
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "lifecycle-attention", objective: "Stop unsafe retries", repository: ".", maxConcurrency: 1 },
    nodes: [{ id: "agent", type: "agent", executor: "codex", prompt: "work", needs: [], owns: [], checks: [], maxAttempts: 2 }],
  };
  const state = createInitialState(graph, []);
  const lifecycle = new RunLifecycle(graph, state);
  lifecycle.startNode("agent");

  assert.deepEqual(
    lifecycle.failNode("agent", "process-tree termination unconfirmed", true),
    { type: "node_failed", nodeId: "agent", detail: "attempt failed and requires operator reconciliation; inspect evidence" },
  );
  assert.equal(lifecycle.attentionRequired(), true);
  assert.deepEqual(lifecycle.finishWhenIdle(), { type: "run_needs_attention" });
  assert.equal(state.status, "needs_attention");
});

test("lifecycle recovery preserves accepted nodes and blocks uncertain external actions", () => {
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "lifecycle-recovery", objective: "Recover safely", repository: ".", maxConcurrency: 2 },
    nodes: [
      { id: "accepted", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1 },
      { id: "agent", type: "agent", executor: "codex", prompt: "work", needs: [], owns: [], checks: [], maxAttempts: 2 },
      { id: "publish", type: "external_action", executor: "shell", target: "publish", needs: [], owns: [], checks: ["publish"], maxAttempts: 2 },
    ],
  };
  const state = createInitialState(graph, []);
  state.nodes.accepted!.status = "accepted";
  state.nodes.agent!.status = "running";
  state.nodes.agent!.attempts = 1;
  state.nodes.publish!.status = "running";
  state.nodes.publish!.attempts = 1;

  const events = new RunLifecycle(graph, state).recoverInterruptedNodes();

  assert.equal(state.nodes.accepted!.status, "accepted");
  assert.equal(state.nodes.agent!.status, "pending");
  assert.equal(state.nodes.agent!.attempts, 1);
  assert.equal(state.nodes.publish!.status, "failed");
  assert.equal(state.nodes.publish!.retryBlocked, true);
  assert.equal(events.length, 2);
});

test("lifecycle gate acceptance authorizes only its exact external action", () => {
  const graph: GraphDefinition = {
    version: 1,
    run: {
      id: "lifecycle-external",
      objective: "Authorize exactly one effect",
      repository: ".",
      maxConcurrency: 1,
      allowExternalActions: true,
    },
    nodes: [
      { id: "gate", type: "human_gate", target: "deploy:production", needs: [], owns: [], checks: [], maxAttempts: 1 },
      { id: "deploy", type: "external_action", executor: "shell", target: "deploy:production", needs: ["gate"], owns: [], checks: ["deploy"], maxAttempts: 1 },
    ],
  };
  const state = createInitialState(graph, []);
  const lifecycle = new RunLifecycle(graph, state);

  assert.equal(lifecycle.readyUnapprovedGate()?.id, "gate");
  assert.deepEqual(lifecycle.awaitApproval("gate"), { type: "approval_required", nodeId: "gate", detail: "deploy:production" });
  lifecycle.approveGate("gate", "deploy:production");
  assert.equal(lifecycle.acceptApprovedGates(), true);
  assert.doesNotThrow(() => lifecycle.assertExternalActionAuthorized("deploy"));
});

test("lifecycle cancellation retry-blocks every running node", () => {
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "lifecycle-cancel", objective: "Cancel safely", repository: ".", maxConcurrency: 2 },
    nodes: [
      { id: "one", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 2 },
      { id: "two", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 2 },
    ],
  };
  const state = createInitialState(graph, []);
  const lifecycle = new RunLifecycle(graph, state);
  lifecycle.startNode("one");
  lifecycle.startNode("two");

  assert.equal(lifecycle.interruptNode("one", false).type, "node_interrupted");
  assert.equal(lifecycle.interruptNode("two", true).type, "node_interrupted");
  assert.deepEqual(lifecycle.cancelRun(), { type: "run_cancelled" });
  assert.equal(state.status, "cancelled");
  assert.equal(state.nodes.one!.retryBlocked, true);
  assert.match(state.nodes.two!.lastError ?? "", /termination was not confirmed/);
});
