# Graph format

The graph is JSON with `version`, `run`, and `nodes`.

```json
{
  "version": 1,
  "run": {
    "id": "unique-run-id",
    "objective": "Observable user outcome",
    "repository": ".",
    "maxConcurrency": 2,
    "codeGraph": true,
    "allowExternalActions": false
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

## Executors

- `codex`: `codex exec` with structured output and workspace/read-only sandbox.
- `claude`: `claude -p` with structured output and bounded tools.
- `shell`: deterministic commands from `checks`; use only for trusted graphs.

## Ownership

`owns` and `implicitOutputs` use `/`-separated globs with `*`, `**`, and `?`.
Parallel nodes must not have overlapping ownership. Include lockfiles,
migrations, generated files, and shared schemas explicitly.

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

