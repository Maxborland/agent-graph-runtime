---
name: agr-development
description: Develop the Agent Graph Runtime repository with an Astra orchestrator, bounded Luna specialists, and an independent Astra reviewer. Use for non-trivial AGR implementation, cross-module debugging, or requested team review. Do not use to execute an AGR-owned graph node or to operate a graph run.
---

# AGR development team

Read the repository `AGENTS.md` first. This skill configures the people-like roles
that develop AGR; it does not replace AGR's deterministic graph scheduler.

## Entry and delegation

1. Determine whether this is repository development or a runtime-owned node.
   Inside a graph node, follow its bounded contract and do not spawn subagents.
2. Inspect the working tree, user goal, relevant contracts, and existing tests.
   State outcome, scope/non-goals, assumptions, risks, and acceptance evidence.
   Create the task's work-log directory and root journal before substantive work,
   following `AGENTS.md` and `docs/development.md#work-logs`.
3. Keep a small localized task in the root. For work that benefits from parallel
   investigation, specialization, context isolation, or independent verification,
   actually spawn bounded subagents. Broad/high-risk work requires independent
   fresh-context review. Do not just narrate a team that was never launched.

## Routing

| Responsibility | Agent | Model / effort | Write policy |
| --- | --- | --- | --- |
| Decisions, decomposition, integration, acceptance | root | GPT-6 Astra / high | Authorized task scope |
| Repository evidence | explorer | GPT-6 Luna / max | Read-only |
| Implementation | worker | GPT-6 Luna / max | Assigned files |
| Verification and regression tests | tester | GPT-6 Luna / max | Assigned tests/fixtures; shared build owner |
| Independent final review | reviewer | GPT-6 Astra / medium | Read-only |
| External compatibility evidence | researcher | GPT-6 Luna / max | Read-only |

Use the named role files in `.codex/agents/` with their pinned model and effort.
Execution roles require `gpt-6-luna` at `max`. Do not substitute GPT-5.6 Luna
or another model without explicit user authorization; report unavailable routing.
The project config sets four concurrent child slots. It does not change this
already-running session. If a named role is unavailable, report that fact; use an
equivalent general agent with the full role instructions and explicit routing
only when supported, or report the missing gate. Never silently claim a pinned
role/model ran. A role file can override spawn settings; do not promise a model
escalation without checking the effective routing. The root decides escalations
when the user requests one or a specialist provides a concrete reasoning blocker.
Do not silently change the project's routing or permission configuration.

## Delegation brief

Give each child:

- One concrete result, the original outcome, and relevant acceptance criteria.
- Exact read/write ownership, non-goals, useful context, and dependencies.
- Constraints, bounded decision rights, and escalation triggers.
- Required validation, evidence to return, and any risky checkpoint before action.
- Task-log directory, unique participant ID, assigned journal path, and direct
  or relay delivery mode. Read-only agents relay `WORK_LOG` entries to the root;
  assign one actual file writer per journal. Logging is required for every role.
- A reminder that other agents share the checkout: preserve their changes,
  coordinate shared builds, and do not spawn a second team.

Escalate scope/architecture changes, public contracts, new dependencies,
permission widening, conflicting edits, unavailable tools, and material ambiguity.
A blocked child returns facts, consequences, options, a recommendation, and the
precise missing decision/resource. The parent resolves the seam; the child keeps
ownership of its slice.

## Work loop

1. Explorer maps only uncertain code paths. Researcher can resolve independent
   external questions in parallel. Skip either when existing evidence suffices.
2. Root chooses the implementation boundary and acceptance plan. Assign workers
   disjoint ownership; serialize dependent changes. Never parallelize writes to
   the same files, lockfile, or generated build directory.
3. Worker implements the bounded result and reports observed checks and gaps.
4. Tester verifies the original outcome on the integrated checkout. Build once,
   run meaningful focused coverage, and exercise the real consumption surface.
   Follow `docs/development.md`; do not substitute fake-provider evidence for a
   live provider result or claim a check ran when it was blocked.
5. Reviewer receives a fresh brief containing the original request, criteria,
   final files/diff, and validation evidence. Inspect independently; do not use the
   implementing worker as its own reviewer. Prefer no inherited conversation.
6. Root verifies findings and routes fixes back to the owning worker. After a
   material fix, rerun affected checks and review the changed final surface.
7. Root inspects the whole final state and accepts the result. Wait for every
   required child to finish or explicitly fail; account for blockers and gaps.
   Keep the index current and persist relayed journal entries throughout the work,
   not only after children finish. Check each journal against the actual evidence.

If spawning fails, state the failure and use a safe bounded fallback where useful.
Do not claim the independent-review gate passed if the root did the review itself.
Do not wait indefinitely on an unresponsive child; inspect status and recover
deliberately without allowing two owners to write the same files.

## Completion

Keep updates focused on findings and decisions. Return the delivered behavior,
verification and runtime evidence, unresolved risks, and completion level.
Before the final response, append the root's outcome and ensure every participant
has a terminal journal entry or an explicitly recorded interruption/logging gap.
Link the task's log index in the final response. Do not reconstruct missing events
as if they were recorded live; distinguish delayed reports from observed events.
Use `implemented`, `verified`, or `runtime-accepted` only for the evidence actually
obtained. All required acceptance gates must pass before saying complete.
Never publish or deploy merely because development validation passed.
