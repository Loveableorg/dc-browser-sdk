/**
 * Tutorial mutation-class heuristic — single source of truth.
 *
 * Used by the Replayable Archetypes "play button" gating (front-end) and by
 * MCP / REST surfaces that need to advertise whether a tutorial/archetype is
 * read-only or causes diagram mutations. Centralised here because we expect
 * to tweak the rules over time as new step types and completion events land,
 * and we want every surface to pick up the change automatically.
 *
 * Inputs are intentionally permissive (`Record<string, unknown>`) so callers
 * can pass raw step rows from the DB, MCP payloads, or in-memory ImportSpec
 * shapes without converting first. We accept both camelCase and snake_case
 * to match `stepInput.ts`.
 *
 * Detection rules (current):
 *  1. Any step whose `completionEvent` is in MUTATING_COMPLETION_EVENTS.
 *  2. Any `run_script` or `run_script_async` step that uses `it.dc` — the
 *     DiagramCraft browser SDK. Today we treat ALL `it.dc` usage as a write
 *     (conservative). Read-only SDK calls can be whitelisted explicitly via
 *     DC_SDK_READONLY_METHODS below once we have time to thread that
 *     through.
 *  3. Recursively walks `bodySteps` of `for_each` / `while_condition` and
 *     would-be branch detour `choices[].steps` if present.
 *
 * NOT yet inspected (intentional — leave for later):
 *  - run_script source AST parsing for specific SDK method calls.
 *  - `setVariable` is NOT considered a diagram mutation (variables are
 *    tutorial-session state).
 *  - `branchOnVariable` / `captureVariable` are session-state only.
 */

/** Completion events that imply the user mutated the diagram. Keep in sync
 *  with the runtime event names emitted in `src/components/tutorial/*`. */
export const MUTATING_COMPLETION_EVENTS: ReadonlySet<string> = new Set([
  "element_added",
  "sub_element_added",
  "element_saved",
  "element_deleted",
  "color_changed",
  "description_added",
  "source_code_attached",
  "source_attached_at_path",
  "tree_scaffolded",
  "json_imported",
  "connections_imported",
  "element_duplicated",
  "element_relocated",
  "git_fetched",
  "connection_added",
  "connection_deleted",
  "connection_edited",
  "element_ejected",
  "element_nested",
  "diagram_ref_added",
  "project_root_set",
  "ide_saved",
]);

/**
 * Explicit allow-list of `it.dc.*` method names that are read-only. Anything
 * NOT listed here is treated as a write when it appears in script source.
 * Empty for now — fill in as we audit DiagramCraftClient. The script-source
 * inspection itself is deferred; this constant is the public contract so
 * future work doesn't need to touch every call site.
 */
export const DC_SDK_READONLY_METHODS: ReadonlySet<string> = new Set([
  // e.g. "getElement", "listChildren", "getVariable" — fill in later.
]);

/** Pull a field by either camelCase or snake_case. */
function pick(step: Record<string, unknown>, camel: string, snake: string): unknown {
  return step[camel] ?? step[snake];
}

function stepType(step: Record<string, unknown>): string {
  const t = step["type"];
  return typeof t === "string" ? t : "standard";
}

/**
 * Returns true if the step (or any nested body step) mutates the diagram.
 * Pass the FULL step shape (camelCase preferred, snake_case tolerated).
 */
export function stepMutatesDiagram(step: Record<string, unknown>): boolean {
  const completionEvent = pick(step, "completionEvent", "completion_event");
  if (typeof completionEvent === "string" && MUTATING_COMPLETION_EVENTS.has(completionEvent)) {
    return true;
  }

  const type = stepType(step);

  if (type === "run_script" || type === "run_script_async") {
    const runScript = pick(step, "runScript", "run_script");
    const source = typeof runScript === "object" && runScript !== null
      ? (runScript as Record<string, unknown>)["script"]
      : undefined;
    if (typeof source === "string" && scriptUsesDcSdk(source)) {
      return true;
    }
  }

  // for_each / while_condition — recurse into bodySteps.
  const containers = [
    pick(step, "forEach", "for_each"),
    pick(step, "whileCondition", "while_condition"),
  ];
  for (const c of containers) {
    if (c && typeof c === "object") {
      const body = (c as Record<string, unknown>)["bodySteps"] ?? (c as Record<string, unknown>)["body_steps"];
      if (Array.isArray(body) && body.some((s) => stepMutatesDiagram(s as Record<string, unknown>))) {
        return true;
      }
    }
  }

  // branch / detour choices may carry nested steps in some shapes.
  const choices = step["choices"];
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (choice && typeof choice === "object") {
        const nested = (choice as Record<string, unknown>)["steps"];
        if (Array.isArray(nested) && nested.some((s) => stepMutatesDiagram(s as Record<string, unknown>))) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Conservative check: does the script source reference the DC SDK at all?
 * Today: any occurrence of `it.dc` or destructured `{ dc }` from `it` counts
 * as a mutation. Refinement (parsing specific method calls, cross-referencing
 * DC_SDK_READONLY_METHODS) is deferred — see file header.
 */
export function scriptUsesDcSdk(source: string): boolean {
  // Match `it.dc.` or `it.dc[` or `it["dc"]` or `it['dc']`.
  if (/\bit\s*\.\s*dc\b/.test(source)) return true;
  if (/\bit\s*\[\s*['"]dc['"]\s*\]/.test(source)) return true;
  // Destructured: `const { dc } = it` (and variants).
  if (/=\s*it\b[^;]*\bdc\b/.test(source) && /\{[^}]*\bdc\b[^}]*\}\s*=\s*it\b/.test(source)) {
    return true;
  }
  return false;
}

/** Returns true if ANY step in the list (recursive) mutates the diagram. */
export function tutorialMutatesDiagram(
  steps: ReadonlyArray<Record<string, unknown>>,
): boolean {
  return steps.some((s) => stepMutatesDiagram(s));
}
