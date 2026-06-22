/**
 * Tutorial mutation-class heuristic — single source of truth.
 *
 * Used by the Replayable Archetypes "play button" gating and by MCP / REST
 * surfaces that need to advertise whether a tutorial/archetype is read-only.
 * Centralised here so every surface picks up rule changes automatically.
 *
 * Inputs are intentionally permissive (`Record<string, unknown>`) so callers
 * can pass raw DB rows, MCP payloads, or in-memory ImportSpec shapes without
 * converting first. Both camelCase and snake_case are accepted to match
 * `stepInput.ts`.
 *
 * Detection rules (current):
 *  1. Any step whose `completionEvent` is in MUTATING_COMPLETION_EVENTS.
 *  2. Any `run_script` / `run_script_async` whose source uses the DC SDK
 *     in a way the AST inspector below classifies as WRITE. Read-only
 *     methods listed in DC_SDK_READONLY_METHODS are allowed.
 *  3. Recursively walks `bodySteps` of `for_each` / `while_condition` and
 *     branch detour `choices[].steps`.
 *
 * NOT considered diagram mutations:
 *  - setVariable / branchOnVariable / captureVariable — tutorial-session
 *    state only.
 */

import { Parser } from "npm:acorn@8.11.3";

// ───────────────────────────────────────────────────────────────────────────
// Public contract
// ───────────────────────────────────────────────────────────────────────────

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
  // NOTE: workspace_target_selected and workspace_iteration_completed are
  // NOT listed here — they're gated per-step (allowCreate / body inspection).
  // NOTE: read-only step completion events that should NEVER appear here:
  //   text_modal_dismissed, variable_captured, variable_set,
  //   targets_selected, script_completed (script body is inspected
  //   separately via scriptUsesDcSdk), source_annotation_dismissed,
  //   element_annotation_dismissed, scope_navigated, condition_met,
  //   workspace_target_selected, workspace_iteration_completed,
  //   diagram_opened, workspace_view_opened (pure navigation).

]);

/**
 * Explicit allow-list of `it.dc.*` method names that are read-only.
 *
 * Anything NOT listed here is treated as a write when the AST inspector finds
 * a call against the DC SDK. Keep tight — false negatives here let mutating
 * archetypes claim `hasMutations:false` and play for workspace viewers.
 *
 * Mirrors the read-only methods on `DiagramCraftClient` in
 * `_shared/lib/sdk/DiagramCraftClient.ts`; update both together.
 */
export const DC_SDK_READONLY_METHODS: ReadonlySet<string> = new Set([
  // SDK reads (pure queries, no writes)
  "getElement",
  "getSourceCode",
  "getResolvedScope",
  // Client construction helpers (return a re-bound client, no IO yet)
  "withDiagram",
  // Generic JS niceties that may appear on `dc` when authors chain
  "toString",
  "valueOf",
]);

/**
 * Workspace SDK (`it.sc` — SpaceCraftClient) read-only allow-list.
 *
 * SpaceCraftClient is a superset of DiagramCraftClient (every DC method
 * is callable on `sc`), so we union DC_SDK_READONLY_METHODS in below.
 * Workspace-only reads add: list diagrams, list members, fetch workspace
 * variables, get the workspace structural snapshot. Mirrors the READ-
 * ONLY methods in `_shared/lib/sdk/SpaceCraftClient.ts` — update both
 * together.
 *
 * Anything NOT listed here (or in DC_SDK_READONLY_METHODS) is treated as
 * a mutation when the AST inspector finds a call against `it.sc`.
 */
export const SC_SDK_READONLY_METHODS: ReadonlySet<string> = new Set([
  ...DC_SDK_READONLY_METHODS,
  // Workspace-level reads
  "listWorkspaceDiagrams",
  "listWorkspaceMembers",
  "getWorkspaceVariables",
  "getWorkspaceStructure",
  // Client re-binding helpers
  "withWorkspace",
]);



// ───────────────────────────────────────────────────────────────────────────
// AST inspector
// ───────────────────────────────────────────────────────────────────────────

// Minimal subset of the ESTree node shape we walk. Acorn returns plain JS
// objects, so we keep this loose.
// deno-lint-ignore no-explicit-any
type Node = any;

/** True if `node` is a MemberExpression resolving to `it.dc` (with optional
 *  computed `it["dc"]`). */
function isItDc(node: Node): boolean {
  return isItProp(node, "dc");
}

/** True if `node` is a MemberExpression resolving to `it.sc` (the
 *  workspace-level SpaceCraftClient). */
function isItSc(node: Node): boolean {
  return isItProp(node, "sc");
}

function isItProp(node: Node, prop: "dc" | "sc"): boolean {
  if (!node || node.type !== "MemberExpression") return false;
  const obj = node.object;
  if (!obj || obj.type !== "Identifier" || obj.name !== "it") return false;
  if (node.computed) {
    return node.property?.type === "Literal" && node.property.value === prop;
  }
  return node.property?.type === "Identifier" && node.property.name === prop;
}

/** Extract the static method name from a MemberExpression like `<obj>.foo`
 *  or `<obj>["foo"]`. Returns null when dynamic. */
function staticMemberName(node: Node): string | null {
  if (!node || node.type !== "MemberExpression") return null;
  if (node.computed) {
    if (node.property?.type === "Literal" && typeof node.property.value === "string") {
      return node.property.value;
    }
    return null;
  }
  return node.property?.type === "Identifier" ? node.property.name : null;
}


/** Recursively walk every child node of `n`, invoking `visit` on each.
 *  Lightweight DIY walker so we don't depend on acorn-walk. */
function walk(n: Node, visit: (node: Node) => void): void {
  if (!n || typeof n !== "object") return;
  if (typeof n.type === "string") visit(n);
  for (const key of Object.keys(n)) {
    if (key === "loc" || key === "start" || key === "end" || key === "range") continue;
    const v = n[key];
    if (!v) continue;
    if (Array.isArray(v)) {
      for (const child of v) walk(child, visit);
    } else if (typeof v === "object") {
      walk(v, visit);
    }
  }
}

/**
 * AST-level inspection. Returns true iff the script contains at least
 * one DC or SC SDK reference (call or property access) whose method
 * name is NOT in the corresponding allow-list. SpaceCraftClient (`it.sc`)
 * is a superset of DiagramCraftClient — workspace constructs may also
 * use `it.dc` directly, so we scan both bindings.
 *
 * Aliasing patterns tracked (for each of `dc` / `sc`):
 *   const { dc } = it;           // destructured top-level binding
 *   const x  = it.dc;            // single-identifier alias
 *   const x  = it["dc"];         // computed form
 *
 * Parse failures fall back to a regex check that conservatively flags
 * any mention of `it.dc` or `it.sc`.
 */
export function scriptUsesDcSdk(source: string): boolean {
  if (!source || typeof source !== "string") return false;

  // Cheap pre-filter: no mention of `dc` or `sc` at all → definitely safe.
  if (!/\b(dc|sc)\b/.test(source)) return false;

  let ast: Node;
  try {
    ast = Parser.parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
    }) as Node;
  } catch {
    return regexFallback(source);
  }

  // Collect aliases for both bindings.
  const dcAliases = new Set<string>();
  const scAliases = new Set<string>();
  walk(ast, (node) => {
    if (node.type !== "VariableDeclarator") return;
    const init = node.init;
    if (!init) return;
    // const x = it.dc / it.sc
    if (node.id?.type === "Identifier") {
      if (isItDc(init)) dcAliases.add(node.id.name);
      else if (isItSc(init)) scAliases.add(node.id.name);
    }
    // const { dc, sc, dc: alias } = it;
    if (
      init.type === "Identifier" &&
      init.name === "it" &&
      node.id?.type === "ObjectPattern"
    ) {
      for (const prop of node.id.properties ?? []) {
        if (prop.type !== "Property") continue;
        const key = prop.key;
        const keyName = key?.type === "Identifier"
          ? key.name
          : key?.type === "Literal" && typeof key.value === "string"
            ? key.value
            : null;
        if (keyName !== "dc" && keyName !== "sc") continue;
        const val = prop.value;
        if (val?.type === "Identifier") {
          (keyName === "dc" ? dcAliases : scAliases).add(val.name);
        }
      }
    }
  });

  let mutatingFound = false;
  let safeFound = false;

  // Collect nodes that appear as `.object` of any MemberExpression so we
  // can exclude `it.sc` / `it.dc` from being flagged as bare references
  // when they're really just the receiver of a method call chain.
  const objectChildren = new Set<Node>();
  walk(ast, (node) => {
    if (node.type === "MemberExpression" && node.object) {
      objectChildren.add(node.object);
    }
    if (node.type === "CallExpression" && node.callee) {
      // `it.sc` is fine as a callee.object — already captured above.
      // Nothing extra needed.
    }
  });

  walk(ast, (node) => {
    if (node.type !== "MemberExpression") return;

    // Which binding (if any) does node.object resolve to?
    let kind: "dc" | "sc" | null = null;
    if (isItDc(node.object)) kind = "dc";
    else if (isItSc(node.object)) kind = "sc";
    else if (node.object?.type === "Identifier") {
      if (dcAliases.has(node.object.name)) kind = "dc";
      else if (scAliases.has(node.object.name)) kind = "sc";
    }
    if (!kind) return;

    const allow = kind === "dc"
      ? DC_SDK_READONLY_METHODS
      : SC_SDK_READONLY_METHODS;

    const methodName = staticMemberName(node);
    if (methodName === null) {
      // Dynamic property access like `dc[fn]` — conservatively a mutation.
      mutatingFound = true;
      return;
    }
    if (allow.has(methodName)) {
      safeFound = true;
    } else {
      mutatingFound = true;
    }
  });

  // Bare `it.dc` / `it.sc` references (no property access) — could be
  // passed elsewhere and used to mutate. Skip cases where the node is the
  // object of an outer MemberExpression (those are method chains and were
  // already inspected above).
  walk(ast, (node) => {
    if (!(isItDc(node) || isItSc(node))) return;
    if (objectChildren.has(node)) return;
    mutatingFound = true;
  });

  if (mutatingFound) return true;
  if (safeFound) return false;
  return false;
}

/** Regex fallback for unparseable source. Conservative: any `it.dc` /
 *  `it.sc` reference counts as a mutation. */
function regexFallback(source: string): boolean {
  if (/\bit\s*\.\s*(?:dc|sc)\b/.test(source)) return true;
  if (/\bit\s*\[\s*['"](?:dc|sc)['"]\s*\]/.test(source)) return true;
  if (
    /=\s*it\b[^;]*\b(?:dc|sc)\b/.test(source) &&
    /\{[^}]*\b(?:dc|sc)\b[^}]*\}\s*=\s*it\b/.test(source)
  ) {
    return true;
  }
  return false;
}



// ───────────────────────────────────────────────────────────────────────────
// Step-level predicates
// ───────────────────────────────────────────────────────────────────────────

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

  // `wait_for_condition` is read-only when its predicate is read-only.
  // Allow-list of write methods is already enforced via scriptUsesDcSdk;
  // we run the same inspector over the predicate source here.
  if (type === "wait_for_condition") {
    const wfc = pick(step, "waitForCondition", "wait_for_condition");
    const src = wfc && typeof wfc === "object"
      ? (wfc as Record<string, unknown>)["predicate"]
      : undefined;
    if (typeof src === "string" && scriptUsesDcSdk(src)) return true;
  }

  // `select_workspace_target` with allowCreate:true mutates (creates a
  // workspace). Without allowCreate it's read-only (selection only).
  if (type === "select_workspace_target") {
    const swt = pick(step, "selectWorkspaceTarget", "select_workspace_target");
    if (swt && typeof swt === "object" && (swt as Record<string, unknown>)["allowCreate"] === true) {
      return true;
    }
  }

  const containers = [
    pick(step, "forEach", "for_each"),
    pick(step, "whileCondition", "while_condition"),
    pick(step, "forEachDiagramInWorkspace", "for_each_diagram_in_workspace"),
  ];
  for (const c of containers) {
    if (c && typeof c === "object") {
      const body = (c as Record<string, unknown>)["bodySteps"] ?? (c as Record<string, unknown>)["body_steps"];
      if (Array.isArray(body) && body.some((s) => stepMutatesDiagram(s as Record<string, unknown>))) {
        return true;
      }
    }
  }

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

/** Returns true if ANY step in the list (recursive) mutates the diagram. */
export function tutorialMutatesDiagram(
  steps: ReadonlyArray<Record<string, unknown>>,
): boolean {
  return steps.some((s) => stepMutatesDiagram(s));
}
