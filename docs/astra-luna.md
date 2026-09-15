# Astra / Luna workflow

This opt-in template allocates planning and independent acceptance to Astra,
and bounded exploration, research, implementation, and test authoring to Luna.
It uses the existing DAG scheduler and separate Codex CLI sessions. It does not
create nested agents or dynamically edit the graph.

```sh
agr init --template astra-luna
# Edit .agent-graph/graph.json before running: objective, ownership, checks, models.
agr validate
agr plan
agr doctor
agr run --verbose
```

Initialization preserves an existing graph (exclusive creation). For a trial
alongside one, use `agr init trial.graph.json --template astra-luna` and pass
`trial.graph.json` to subsequent commands.

| Node | Routing | Responsibility |
| --- | --- | --- |
| orchestrator | Codex / gpt-6-astra, read-only | Bounded plan and acceptance criteria |
| explorer | Codex / gpt-5.6-luna, read-only | Code paths, interfaces, risks |
| researcher | Codex / gpt-5.6-luna, read-only | Technical uncertainties and sources |
| worker | Codex / gpt-5.6-luna | Production changes within src/** |
| tester | Codex / gpt-5.6-luna | Independent tests within test/** |
| test-checks | Runtime shell | pnpm test |
| reviewer | Codex / gpt-6-astra, read-only | Independent inspection of code and evidence |
| integrate | Codex / gpt-6-astra, read-only | Reconcile outcomes and final acceptance |
| final-checks | Runtime shell | pnpm test on final checkout |

Only explorer and researcher run concurrently. Worker waits for both and the
plan. Tester follows worker; deterministic tests precede reviewer and final
acceptance. Every role that needs the original plan has a direct dependency on
orchestrator so it receives that handoff explicitly.

Set a concrete `run.objective`. Adjust `owns` for the target repository, including
any needed configuration or lockfiles, and replace both `pnpm test` checks with
meaningful project commands if appropriate. The defaults fit this repository.
Keep test and source ownership narrow. Verify that the installed, authenticated
Codex CLI can actually route the configured model IDs; initialization and doctor
do not prove account-level model availability. No model invocation is performed
by initialization. Research uses the tools available to the CLI session; this
template does not enable web access or promise live research.

## Context and acceptance

Nodes share a checkout, not a conversation. The runtime loads current accepted
direct-dependency handoffs and check exit codes from saved evidence on every
agent invocation, including resume. Excerpts are capped at 12,000 characters
per dependency and 48,000 payload characters overall. The overall budget is
shared equally across dependencies so long upstream reports cannot consume the
reviewer's share. Check results and handoff caveats precede narrative summaries.
Each evidence entry includes its full file path; raw command output and unknown
handoff fields are excluded.

Saved handoffs must be complete and well-formed, with a successful agent process.
Recorded checks must match the graph's configured commands and have succeeded.
Missing, damaged, or inconsistent accepted evidence stops the downstream attempt
before dispatch and requires operator attention without automatic retries.

The final Astra session performs read-only integration of conclusions. Source
and tests are already together in the shared checkout; no worktree merge is
required. It must report blocked if code changes are necessary, so new changes
cannot silently bypass the independent reviewer. Deterministic checks gate
acceptance separately from model claims.

## Rework

This version has no automatic backward edges or repair loop. A semantic
`blocked` or `partial` handoff stops for attention. Inspect `agr inspect`,
`agr logs reviewer`, and the node evidence first. Preserve actionable findings
before retrying: `agr retry worker` clears worker and descendant evidence
references and reruns the downstream chain; it does not automatically feed
the rejected review back to worker. For example, save the findings in a
repository task brief that the worker's existing prompt already references.
If the graph prompt, ownership, or objective must change, use a new `run.id`.

After inspecting partial effects and preserving the brief:

```sh
agr retry worker
agr run --verbose
```

Every node defaults to one attempt. The orchestrator is a planner within the
fixed graph; graph expansion, escalation to a different worker model, and
bounded automatic repair would be separate runtime features.
