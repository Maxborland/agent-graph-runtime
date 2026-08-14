# Agent Graph Runtime

`agr` is a local, resumable task-graph runtime that invokes the installed Codex
CLI, native Claude Code CLI, or proxy-routed Claudex launcher. The graph, not
any model's conversation, owns
dependencies, retries, path ownership, checks, evidence, and human approvals.

Current status: working local v0.2.0, not published to npm.

## Requirements

- Node.js 22+, Git, and pnpm
- PowerShell 7 (`pwsh`) when using a Windows `claudex.ps1` launcher
- authenticated `codex`, native `claude`, and/or configured `claudex` on `PATH`
- a trusted Git checkout; shell checks in a graph execute as local commands

## Install and use

```powershell
pnpm install
pnpm build
pnpm link --global
agr install-skills --project C:\path\to\repo
```

Put the graph at `<repo>/.agent-graph/graph.json`, run commands from the repo
root, then:

```powershell
agr validate
agr run
agr status
```

At a gate, `agr run` exits with code 2. The runtime cannot approve for you:

```powershell
agr approve approve-production deploy:production
agr run
```

To deliberately rerun a node and invalidate all descendants:

```powershell
agr retry implementation
agr run
```

See [examples/read-only-smoke.graph.json](examples/read-only-smoke.graph.json)
for a safe graph that exercises both native adapters,
[examples/claudex-smoke.graph.json](examples/claudex-smoke.graph.json) for the
proxy-routed launcher, and
[skills/agent-graph-runtime/references/graph-format.md](skills/agent-graph-runtime/references/graph-format.md)
for the complete graph format.

## Runtime contract

- `codex` nodes use `codex exec`, JSON schema output, and Codex sandboxing.
- `claude` nodes use native `claude -p`, JSON schema output, and bounded tools.
- `claudex` nodes use the same print-mode protocol through the PATH-resolved
  Claudex launcher. They retain distinct evidence and never fall back to native
  Claude or Codex.
- review nodes are read-only; implementation nodes are workspace-scoped.
- configured checks run outside the model and gate acceptance.
- state is atomically persisted under `.agent-graph/runs/<run-id>/`; raw CLI
  output, prompts, evidence, events, and the final report remain auditable.
- changed graph content cannot resume under an existing `run.id`.
- external actions are off by default and require both graph opt-in and an exact
  accepted human gate.

Claudex owns its proxy, authentication, main Sol model, Luna subagent routing,
effort, compaction, and context-window settings. A graph using
`executor: "claudex"` therefore cannot set `model`.

## Security and limitations

Review graph files before running them: `checks` are trusted shell commands.
The runtime never bypasses CLI permissions, auto-approves a gate, reverts an
ownership violation, deploys, pushes, or sends messages unless an explicitly
authorized external-action node defines that operation.

Parallel nodes share one checkout in v0.2.0. Their ownership patterns must be
disjoint, and wave changes plus handoff claims are checked. Because Git cannot
attribute a same-checkout path to one concurrent process, use
`maxConcurrency: 1` when strict per-process attribution matters. Automated
worktree isolation/merge, a hosted UI, and automatic task invention are outside
this version.

## Development

```powershell
pnpm test
pnpm pack --dry-run
```

The behavioral contract and acceptance mapping are in
[docs/SPEC.md](docs/SPEC.md).
