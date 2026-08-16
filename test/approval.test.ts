import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { OperatorControl } from "../src/operator-control.js";
import { evaluateMandate } from "../src/authority.js";
import { GraphRunner } from "../src/runner.js";
import { verifyRunEvidenceArtifacts } from "../src/evidence.js";
import { createInitialState } from "../src/state.js";
import type { GraphDefinition } from "../src/types.js";

const exec = promisify(execFile);

test("human gate stops the run until its exact target is approved", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-approval-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
  const graph: GraphDefinition = {
    version: 1,
    run: {
      id: "approval-fixture",
      objective: "Require a human decision",
      repository: ".",
      maxConcurrency: 1,
    },
    nodes: [
      {
        id: "release-approval",
        type: "human_gate",
        target: "deploy:production",
        prompt: "Approve production deployment",
        needs: [],
        owns: [],
        checks: [],
        maxAttempts: 1,
      },
    ],
  };

  try {
    const runner = new GraphRunner(graph, root, {});
    assert.equal((await runner.run()).status, "awaiting_approval");
    const control = new OperatorControl(graph, root);
    await assert.rejects(
      control.approve("release-approval", "deploy:staging"),
      /does not match/,
    );
    await control.approve("release-approval", "deploy:production");
    const completed = await runner.run();
    assert.equal(completed.status, "completed");
    assert.equal(completed.nodes["release-approval"]!.status, "accepted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approval receipt is single-use and repository drift blocks external dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-approval-receipt-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
  const marker = join(root, "published.txt");
  const graph: GraphDefinition = {
    version: 1,
    run: {
      id: "approval-receipt",
      objective: "Bind one exact effect",
      repository: ".",
      maxConcurrency: 1,
      allowExternalActions: true,
    },
    nodes: [
      {
        id: "approval",
        type: "human_gate",
        target: "publish:fixture",
        needs: [],
        owns: [],
        checks: [],
        maxAttempts: 1,
      },
      {
        id: "publish",
        type: "external_action",
        executor: "shell",
        target: "publish:fixture",
        needs: ["approval"],
        owns: [],
        checks: [`${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync('published.txt','once')"`],
        maxAttempts: 1,
      },
    ],
  };

  try {
    const runner = new GraphRunner(graph, root, {});
    assert.equal((await runner.run()).status, "awaiting_approval");
    const approved = await new OperatorControl(graph, root).approve("approval", "publish:fixture");
    assert.equal(approved.authority.receipts.length, 1);
    assert.equal(approved.authority.receipts[0]!.actionNodeId, "publish");

    await writeFile(join(root, "README.md"), "drifted\n");
    const drifted = await runner.run();
    assert.equal(drifted.status, "failed");
    assert.match(drifted.nodes.publish!.lastError ?? "", /repository fingerprint changed/);
    await assert.rejects(access(marker));
    assert.equal(drifted.authority.consumptions.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed external action is dispatched once and requires reconciliation before retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-external-once-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
  const countPath = join(root, "effect-count.txt");
  const graph: GraphDefinition = {
    version: 1,
    run: {
      id: "external-once",
      objective: "Never duplicate uncertain effects",
      repository: ".",
      maxConcurrency: 1,
      allowExternalActions: true,
    },
    nodes: [
      { id: "approval", type: "human_gate", target: "send:fixture", needs: [], owns: [], checks: [], maxAttempts: 1 },
      {
        id: "send",
        type: "external_action",
        executor: "shell",
        target: "send:fixture",
        needs: ["approval"],
        owns: [],
        checks: [
          `${JSON.stringify(process.execPath)} -e "const f='effect-count.txt',n=+(require('node:fs').existsSync(f)?require('node:fs').readFileSync(f,'utf8'):0);require('node:fs').writeFileSync(f,String(n+1));process.exit(1)"`,
        ],
        maxAttempts: 3,
      },
    ],
  };

  try {
    const runner = new GraphRunner(graph, root, {});
    assert.equal((await runner.run()).status, "awaiting_approval");
    const control = new OperatorControl(graph, root);
    await control.approve("approval", "send:fixture");
    const failed = await runner.run();
    assert.equal(failed.status, "needs_attention");
    assert.equal(await readFile(countPath, "utf8"), "1");
    assert.equal(failed.authority.reservations.length, 1);
    assert.equal(failed.authority.consumptions.length, 1);

    const resumed = await runner.run();
    assert.equal(resumed.status, "needs_attention");
    assert.equal(await readFile(countPath, "utf8"), "1");
    await assert.rejects(control.retry("send"), /requires --reconciliation evidence/);
    const reconciliationPath = join(root, "reconciliation.txt");
    await writeFile(reconciliationPath, "provider confirms the first attempt failed after one recorded effect\n");
    await assert.rejects(
      control.retry("send", reconciliationPath),
      /requires a newly issued approval receipt/,
    );
    await control.approve("approval", "send:fixture");
    const reset = await control.retry("send", reconciliationPath);
    assert.equal(reset.nodes.send!.generation, 1);
    assert.equal(reset.authority.reconciliations.length, 1);
    const reconciliationArtifact = join(
      root,
      ".agent-graph",
      "runs",
      graph.run.id,
      reset.authority.reconciliations[0]!.localPath,
    );
    const reconciliationBytes = await readFile(reconciliationArtifact);
    await writeFile(reconciliationArtifact, "tampered reconciliation\n");
    await assert.rejects(
      verifyRunEvidenceArtifacts(join(root, ".agent-graph", "runs", graph.run.id), reset),
      /failed byte-level integrity verification/,
    );
    await writeFile(reconciliationArtifact, reconciliationBytes);

    const retried = await runner.run();
    assert.equal(retried.status, "needs_attention");
    assert.equal(await readFile(countPath, "utf8"), "2");
    assert.equal(retried.authority.consumptions.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tampered dependency evidence blocks external dispatch before receipt consumption", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-approval-evidence-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
  let externalCalls = 0;
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "evidence-bound", objective: "bind evidence bytes", repository: ".", maxConcurrency: 1, allowExternalActions: true },
    nodes: [
      { id: "prepare", type: "agent", executor: "codex", prompt: "prepare", needs: [], owns: [], checks: [], maxAttempts: 1 },
      { id: "approval", type: "human_gate", target: "publish:fixture", needs: ["prepare"], owns: [], checks: [], maxAttempts: 1 },
      { id: "publish", type: "external_action", executor: "codex", target: "publish:fixture", prompt: "publish", needs: ["prepare", "approval"], owns: [], checks: [], maxAttempts: 1 },
    ],
  };
  const adapter = {
    async execute(request: { node: { id: string } }) {
      if (request.node.id === "publish") externalCalls += 1;
      return { handoff: { status: "complete" as const, summary: "done", changedFiles: [], verification: [], gaps: [] }, stdout: "", stderr: "", exitCode: 0 };
    },
  };
  try {
    const runner = new GraphRunner(graph, root, { codex: adapter });
    const waiting = await runner.run();
    await new OperatorControl(graph, root).approve("approval", "publish:fixture");
    const artifact = Object.values(waiting.attempts).find((attempt) => attempt.nodeId === "prepare")!.evidence[0]!;
    await writeFile(join(root, ".agent-graph", "runs", graph.run.id, artifact.localPath), "tampered\n");

    const failed = await runner.run();

    assert.equal(failed.status, "failed");
    assert.equal(externalCalls, 0);
    assert.equal(failed.authority.consumptions.length, 0);
    assert.match(failed.nodes.publish!.lastError ?? "", /byte-level integrity verification/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deterministic policy records a denial and cannot expand the human mandate", () => {
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "mandate-deny", objective: "deny escalation", repository: ".", maxConcurrency: 1, allowExternalActions: true },
    nodes: [{
      id: "publish",
      type: "external_action",
      executor: "shell",
      target: "publish:production",
      needs: [],
      owns: [],
      checks: ["publish"],
      maxAttempts: 1,
    }],
  };
  const state = createInitialState(graph, []);
  state.authority.mandate.allowedTargets = [];

  assert.throws(() => evaluateMandate(graph, state, "publish"), /exceeds the human-issued run mandate/);
  assert.equal(state.authority.policyDecisions.at(-1)?.outcome, "deny");

  state.authority.mandate.allowedTargets = ["publish:production"];
  state.authority.mandate.maxDepth = 0;
  assert.throws(() => evaluateMandate(graph, state, "publish"), /exceeds the human-issued run mandate/);

  state.authority.mandate.maxDepth = 1;
  state.authority.mandate.issuedAt = "2020-01-01T00:00:00.000Z";
  state.authority.mandate.maxDurationMs = 1;
  assert.throws(() => evaluateMandate(graph, state, "publish"), /exceeds the human-issued run mandate/);
});
