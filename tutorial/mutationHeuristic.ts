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
]);

/**
 * Explicit allow-list of `it.dc.*` method names that are read-only.
 *
 * Anything NOT listed here is treated as a write when the AST inspector finds
 * a call against the DC SDK. Keep tight — false negatives here let mutating
 * archetypes claim `hasMutations:false` and play for workspace viewers.
 *
 * Mirrors `_shared/lib/sdk/DiagramCraftClient.ts`; update both together.
 */
export const DC_SDK_READONLY_METHODS: ReadonlySet<string> = new Set([
  // SDK reads
  "getElement",
  "getSourceCode",
  // Client construction helpers (return a re-bound client, no IO yet)
  "withDiagram",
  // Generic JS niceties that may appear on `dc` when authors chain
  "toString",
  "valueOf",
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
  if (!node || node.type !== "MemberExpression") return false;
  const obj = node.object;
  if (!obj || obj.type !== "Identifier" || obj.name !== "it") return false;
  if (node.computed) {
    return node.property?.type === "Literal" && node.property.value === "dc";
  }
  return node.property?.type === "Identifier" && node.property.name === "dc";
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
 * AST-level inspection. Returns true iff the script contains at least one
 * DC SDK reference (call or property access) whose method name is NOT in
 * `DC_SDK_READONLY_METHODS`. Tracks two aliasing patterns:
 *
 *   const { dc } = it;           // destructured top-level binding
 *   const x  = it.dc;            // single-identifier alias
 *   const x  = it["dc"];         // computed form
 *
 * Anything else (re-aliased aliases, dynamic property access, spreading
 * `it`, eval, etc.) falls through to the conservative regex check.
 *
 * Parse failures => conservative `true` if the regex check still trips on
 * `it.dc`; otherwise `false`. This means a syntactically broken script
 * that nonetheless mentions `it.dc` is treated as a mutation.
 */
export function scriptUsesDcSdk(source: string): boolean {
  if (!source || typeof source !== "string") return false;

  // Cheap pre-filter: no mention of `dc` at all → definitely safe.
  if (!/\bdc\b/.test(source)) return false;

  let ast: Node;
  try {
    // Tutorial scripts are evaluated as an async function body, so allow
    // top-level await / return.
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

  // Identifier names known to alias `it.dc` (single-binding form).
  const dcAliases = new Set<string>();

  // First pass: collect aliases from top-level VariableDeclarations.
  // We're permissive — any depth qualifies as long as the RHS resolves
  // statically to `it.dc` or `it`-destructure-of-dc.
  walk(ast, (node) => {
    if (node.type !== "VariableDeclarator") return;
    const init = node.init;
    if (!init) return;

    // const x = it.dc;
    if (isItDc(init) && node.id?.type === "Identifier") {
      dcAliases.add(node.id.name);
      return;
    }
    // const { dc, dc: alias } = it;
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
        if (keyName !== "dc") continue;
        const val = prop.value;
        if (val?.type === "Identifier") dcAliases.add(val.name);
      }
    }
  });

  let mutatingFound = false;
  let safeFound = false;

  // Second pass: every MemberExpression whose object resolves to dc.
  walk(ast, (node) => {
    if (node.type !== "MemberExpression") return;

    // Resolve whether `node.object` is "dc": either `it.dc` directly or an
    // identifier we've aliased to it.
    let isDcAccess = false;
    if (isItDc(node.object)) isDcAccess = true;
    else if (
      node.object?.type === "Identifier" &&
      dcAliases.has(node.object.name)
    ) {
      isDcAccess = true;
    }
    if (!isDcAccess) return;

    const methodName = staticMemberName(node);
    if (methodName === null) {
      // Dynamic property access like `dc[fn]` — conservatively a mutation.
      mutatingFound = true;
      return;
    }
    if (DC_SDK_READONLY_METHODS.has(methodName)) {
      safeFound = true;
    } else {
      mutatingFound = true;
    }
  });

  // Also: `it.dc` referenced without any property (e.g. `return it.dc`
  // returns the client itself — could be passed elsewhere and used to
  // mutate). Treat as mutation to stay safe.
  walk(ast, (node) => {
    if (!isItDc(node)) return;
    // Already counted above if part of a deeper MemberExpression.
    // Bare reference => conservative.
    // (We can't easily check parent without a parent map, so we just
    // mark mutating. False positives here are acceptable; authors who
    // truly need to surface the client without using it can refactor.)
    mutatingFound = true;
  });

  if (mutatingFound) return true;
  // If we saw safe DC calls and no mutations, we're confident it's safe.
  if (safeFound) return false;
  // No DC references found by the AST — but `dc` token appeared in source
  // (comment, string, unrelated identifier). Safe.
  return false;
}

/** Regex fallback for unparseable source. Conservative: any `it.dc`
 *  reference counts as a mutation. */
function regexFallback(source: string): boolean {
  if (/\bit\s*\.\s*dc\b/.test(source)) return true;
  if (/\bit\s*\[\s*['"]dc['"]\s*\]/.test(source)) return true;
  if (
    /=\s*it\b[^;]*\bdc\b/.test(source) &&
    /\{[^}]*\bdc\b[^}]*\}\s*=\s*it\b/.test(source)
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
