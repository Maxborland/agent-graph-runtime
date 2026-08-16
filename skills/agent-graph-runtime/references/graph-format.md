# Graph format

The graph is JSON with `version`, `run`, and `nodes`.
Relative `run.repository` paths resolve from the graph file. The conventional
`.agent-graph/graph.json` with `repository: "."` aliases the repository root for
backward-compatible default-command use.
With `run.codeGraph: true`, the runtime obtains CodeGraph status and a targeted
exploration outside the review sandbox even when a node has no explicit
`context`; explicit symbols/impact/files refine that precomputed context.

```json
{
  "version": 1,
  "run": {
    "id": "unique-run-id",
    "objective": "Observable user outcome",
    "repository": ".",
    "maxConcurrency": 2,
    "codeGraph": true,
    "allowExternalActions": false,
    "advisor": {
      "executor": "codex",
      "model": "gpt-5.6-sol",
      "instructions": "Watch architecture, safety, and evidence quality.",
      "stopOnBlocker": true
    }
  },
  "nodes": [
    {
      "id": "implementation",
      "type": "agent",
      "executor": "codex",
      "prompt": "Implement the bounded behavior",
      "needs": [],
      "owns": ["src/**", "test/**"],
      "implicitOutputs": ["pnpm-lock.yaml"],
      "checks": ["pnpm test"],
      "maxAttempts": 2,
      "timeoutMs": 1200000,
      "context": {
        "symbols": ["PublicApi"],
        "impact": ["PublicApi.create"],
        "affectedFiles": ["src/public-api.ts"]
      }
    }
  ]
}
```

## Node types

- `agent`: writable Codex or Claude implementation.
- `review`: read-only Codex or Claude inspection.
- `verify`: deterministic commands executed by the runtime.
- `human_gate`: exact authorization target; never model-approved.
- `external_action`: disabled by default and requires an accepted matching gate.

## Passive advisor

`run.advisor` declares an optional second model that reviews each completed wave
before another wave starts. It always uses the read-only review adapter, owns no
paths, writes separate evidence, and maps handoff status `complete`, `partial`,
and `blocked` to note, concern, and blocker. Claudex advisors must not set
`model`; their launcher owns routing. A blocker stops by default and requires
explicit `agr advisor acknowledge` after evidence inspection.

## Executors

- `codex`: `codex exec` with structured output and workspace/read-only sandbox.
- `claude`: `claude -p` with structured output and bounded tools.
- `claudex`: the configured Claudex launcher using the Claude Code print-mode
  protocol. Do not set `model`; the launcher owns routing and context. Claudex
  nodes execute directly and cannot launch `Workflow`, `Task`, `Agent`, or hidden subagents.
- `shell`: deterministic commands from `checks`; use only for trusted graphs.

## Claudex model evidence

A Claudex node may require launcher-reported model metadata. The runner rejects
missing or mismatched entries and stores observed `modelUsage` in node evidence:

```json
"requiredModelUsage": [
  { "model": "gpt-5.6-sol", "provider": "firstParty", "contextWindow": 262144 },
  { "model": "gpt-5.6-luna", "provider": "firstParty", "contextWindow": 262144 }
]
```

This field is valid only with `executor: "claudex"` on a node type that dispatches
an agent adapter. It is rejected on `verify` and `human_gate` nodes. Handoff text
does not satisfy the requirement.

## Ownership

`owns` and `implicitOutputs` use `/`-separated globs with `*`, `**`, and `?`.
Parallel nodes must not have overlapping ownership. Include lockfiles,
migrations, generated files, and shared schemas explicitly.

## Orchestration boundary

Each node must finish its own work before returning its handoff. Do not put
Workflow, Task, subagent, or nested executor instructions in a prompt. Split
independently routed, reviewed, or accepted work into explicit nodes with
dependencies and ownership. Run a graph in a dedicated checkout with no
unrelated writer; ownership detection cannot attribute concurrent out-of-graph
edits safely.

## Human gate example

```json
[
  {
    "id": "approve-production",
    "type": "human_gate",
    "target": "deploy:production",
    "prompt": "Approve production deployment",
    "needs": ["runtime-qa"],
    "owns": [],
    "checks": [],
    "maxAttempts": 1
  },
  {
    "id": "deploy-production",
    "type": "external_action",
    "executor": "shell",
    "target": "deploy:production",
    "needs": ["approve-production"],
    "owns": [],
    "checks": ["./trusted-deploy-script"],
    "maxAttempts": 1
  }
]
```

The graph must also set `run.allowExternalActions` to `true`. This only enables
the capability; `agr approve` remains mandatory.
