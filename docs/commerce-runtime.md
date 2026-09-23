# Explicit execution and durable review evidence

These additions address the Commerce integration issues #3, #4, and #5. Existing
graphs may omit the new options. No model, effort, or executor fallback is added.

## Codex reasoning effort

Set `reasoningEffort` on each Codex agent/review node, and separately on
`run.advisor` when using a Codex advisor:

```json
{
  "executor": "codex",
  "model": "gpt-5.6-luna",
  "reasoningEffort": "max"
}
```

The runtime places the explicit effort override among the arguments **after**
`codex exec`, alongside the approval-policy override. Host configuration is still
used when effort is omitted. Native Claude, Claudex, shell checks, and human
gates cannot receive this Codex-specific setting. Allowed effort names are
`minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; the selected
model must support the requested value. Provider errors are surfaced without
substituting a different model or effort.

`configuredExecution` records the requested model and effort. `observedExecution`
records only metadata actually supplied by Codex, including the live thread ID;
requested values never stand in for observed values. The adapter captures the
thread ID while reading the live JSONL stream, before bounded stdout retention
can discard the initial event. When the stream omits effective settings, AGR
reads only the exact thread rollout from the local Codex sessions directory,
verifying its ID, repository, and invocation time. It copies no prompt or
reasoning text. Missing provider metadata stays unknown; it is not proof of
the configured setting. Observed mismatches block retries and retain evidence.
Session metadata is checked even after a nonzero provider exit. If settings change within a session, both conflicting observations are retained and automatic retry is blocked. Handoff prose is not execution metadata.

See [the runnable example](../examples/commerce-reviews.graph.json). Give each
new graph contract a new `run.id`; an existing run cannot resume with changed
graph content. Remove the Commerce effort-injecting wrapper when using this
native configuration.

## Keep independent review results

The default `run.semanticFailurePolicy` is `"stop"`, which cancels the wave on
an agent's `partial` or `blocked` handoff. To collect the remaining independent
evidence, set:

```json
"semanticFailurePolicy": "finish-independent-read-only"
```

Retention applies only to an already-started wave made entirely of read-only
review nodes (not shell executors) and verify nodes, with no declared `owns` or
`implicitOutputs`. Trusted verify commands must themselves be read-only; empty
ownership is a contract checked by repository snapshots, not an operating-system
shell sandbox. Checks that generate or modify files must declare those outputs
and therefore do not qualify for retention.

The original finding remains failed and retry-blocked, the independent peer can
be accepted with its full evidence, and the run ends `needs_attention` (exit 5).
No next wave or advisor is started. A mixed wave containing implementation or
external-action work retains immediate cancellation because its effects may be
uncertain. Known semantic stops signal cancellation before awaiting ownership
scanning; final ownership checks still control acceptance. User cancellation,
claimed or detected ownership escapes, and unconfirmed
termination also stop peers. Under retention, an otherwise unclassified executor
error conservatively stops the read-only wave; default ordinary provider failures
retain their existing automatic retry behavior. A success returned
after such a stop is not accepted.

Inspect the finding using `agr inspect`, `agr why`, `agr logs`, and `agr report`.
Correct the underlying issue before explicitly retrying the affected node.
This policy preserves evidence; it does not accept or suppress a review finding.

## Manual retries and existing run directories

`agr retry <node> <graph>` invalidates that node and its descendants, but retains
their historical evidence references, prompts, raw output, and check results.
The next execution receives a higher numeric `node-attempt-N` identity. Only the
automatic retry budget is reset; `maxAttempts` applies to the new retry cycle.
Repeated retries do not reuse old paths. Independent accepted nodes are retained.

State separates the lifetime ordinal (`attempts`) from the current cycle's
budget (`generationAttempts`), and records the accepted attempt separately.
Dependency prompts consume only the current accepted attempt. Invalidated or
failed historical results never become accepted input merely because their
files remain on disk. `agr logs <node>` includes historical raw outputs;
`agr report` and state evidence references preserve the inspection trail.

Existing graph hashes and numeric artifact paths remain valid. On opening a
legacy run, AGR initializes the budget from its previous counter and discovers
the highest existing attempt number in prompts, evidence, outputs, and start
events before allocating another identity. An orphan higher-numbered artifact
does not replace the previously accepted dependency evidence. Artifact writes
fail on conflicting existing content rather than replacing it.

Stop any old AGR process before upgrading or retrying a run. Do not run the old
runtime against a run resumed by this version: the old retry implementation can
still reset counters and overwrite evidence. Back up existing run directories
before returning to an older runtime. Evidence already overwritten by an older
version cannot be reconstructed by this fix. Changed graph content still
requires a new run ID; never edit state to bypass that guard.
