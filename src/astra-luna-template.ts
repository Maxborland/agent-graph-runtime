import type { GraphNodeDefinition } from "./types.js";

/** Explicit graph nodes: these are separate CLI sessions, not nested agents. */
export function astraLunaNodes(): GraphNodeDefinition[] {
  const review = (id: string, model: string, needs: string[], prompt: string): GraphNodeDefinition => ({
    id, type: "review", executor: "codex", model, needs, prompt,
    owns: [], checks: [], maxAttempts: 1,
  });
  const astra = "gpt-6-astra";
  const luna = "gpt-5.6-luna";
  return [
    review("orchestrator", astra, [], "Turn the objective into a bounded implementation plan, acceptance criteria, and risks. Put the plan in your handoff summary. Respect the graph's existing ownership and dependencies; do not invent or launch tasks. Return blocked if the objective is still a placeholder or cannot fit this graph."),
    review("explorer", luna, ["orchestrator"], "Inspect the relevant code, interfaces, and existing tests using the plan. Report exact paths, constraints, and suggested change points in your handoff summary."),
    review("researcher", luna, ["orchestrator"], "Resolve technical uncertainties from repository documentation and available primary sources. Include sources, recommendations, and remaining uncertainty in your handoff. Do not imply that unavailable web access was used. Return blocked if an essential question cannot be resolved."),
    {
      id: "worker", type: "agent", executor: "codex", model: luna,
      needs: ["orchestrator", "explorer", "researcher"], owns: ["src/**"],
      prompt: "Implement the plan using the explorer and researcher handoffs. Change only owned source files. Summarize behavior, changed interfaces, and remaining risks for the tester. Return blocked if required changes exceed ownership.",
      checks: [], maxAttempts: 1,
    },
    {
      id: "tester", type: "agent", executor: "codex", model: luna,
      needs: ["orchestrator", "explorer", "researcher", "worker"], owns: ["test/**"],
      prompt: "Independently add or update meaningful tests for the acceptance criteria, regressions, and edge cases. Do not alter production source or weaken assertions to hide defects. The runtime executes the configured test command next. Report implementation defects as blocked with exact reproduction details.",
      checks: [], maxAttempts: 1,
    },
    { id: "test-checks", type: "verify", needs: ["tester"], owns: [], checks: ["pnpm test"], maxAttempts: 1 },
    review("reviewer", astra, ["orchestrator", "explorer", "researcher", "worker", "tester", "test-checks"], "Independently inspect the actual diff, tests, and dependency evidence against the original acceptance criteria. Check correctness, security, and scope. Handoffs are claims, not proof. Return blocked with actionable findings for any unresolved defect; complete only when the implementation is acceptable."),
    review("integrate", astra, ["orchestrator", "worker", "tester", "test-checks", "reviewer"], "Reconcile the original plan, implementation, test evidence, and independent review in this shared checkout. This is a fresh session: use the supplied handoffs and inspect the final files. Make the final acceptance decision and summarize outcome and limitations. Do not modify reviewed code; return blocked if integration requires changes so the worker and downstream checks can be rerun."),
    { id: "final-checks", type: "verify", needs: ["integrate"], owns: [], checks: ["pnpm test"], maxAttempts: 1 },
  ];
}
