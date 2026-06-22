// Cross-runtime domain types for Construct Import JSON.
//
// A construct's "baseDiagram" was originally a single ImportElement tree
// scaffolded under the host diagram. Workspace constructs need to seed
// MORE than a single diagram — potentially a whole workspace populated
// with multiple diagrams (and, when the data model later supports it,
// nested folders). The new `ImportDiagramElement` discriminated union
// is the seed payload shape that covers both:
//
//   { kind: "diagram",   ...ImportDiagram   }  ← diagram-bound construct
//   { kind: "workspace", ...ImportWorkspace }  ← workspace construct
//
// A diagram-bound construct ("hasMutations" gates whether read-only
// viewers can play it) operates on ONE host diagram via `it.dc`
// (DiagramCraftClient). A workspace construct operates over a whole
// workspace via `it.sc` (SpaceCraftClient — a superset of DC) and may
// create/modify any number of diagrams within that workspace.
//
// Pure TypeScript; mirror Zod schemas live in ../schemas/import.ts.

import type { ImportConnection, ImportElement, ImportVariable } from "./types.ts";

/** A single diagram payload: title + element tree + sibling-level
 *  connections + (optionally scoped) variables. Tags are workspace-scoped
 *  labels matched by name at import time. */
export interface ImportDiagram {
  title: string;
  description?: string | null;
  elements: ImportElement[];
  connections?: ImportConnection[];
  variables?: ImportVariable[];
  /** Workspace tag names to apply. Unknown tags are ignored (not auto-created). */
  tags?: string[];
  /** When true, this diagram is a Play-button anchor for a replayable
   *  workspace construct. The card renders as a launch button (clicking
   *  it spawns a tutorial session instead of opening the diagram). At
   *  most ONE entity in a workspace seed may set this; launch-point
   *  diagrams should carry only title / description / variables (no
   *  elements or connections). */
  isLaunchPoint?: boolean;
}

/** A workspace seed: name, description, workspace-level variables, and
 *  any number of diagrams (and, optionally, nested sub-workspaces — the
 *  data model does not yet support folders; the field exists so importers
 *  / pickers can be authored against the final shape today). */
export interface ImportWorkspace {
  name: string;
  description?: string | null;
  /** Workspace-scoped variables (sit between system and global in the
   *  template precedence chain — see mem://features/workspace-variables). */
  variables?: ImportVariable[];
  diagrams?: ImportDiagram[];
  workspaces?: ImportWorkspace[];
  /** When true, this workspace is itself the Play-button anchor for the
   *  enclosing replayable construct. Only meaningful for sub-workspaces
   *  in nested seeds (forward-compat with sub-workspaces). */
  isLaunchPoint?: boolean;
}

/** Discriminated union — the seed payload for any construct flavor.
 *  Diagram-bound constructs use the `diagram` variant; workspace
 *  constructs use the `workspace` variant. */
export type ImportDiagramElement =
  | ({ kind: "diagram" } & ImportDiagram)
  | ({ kind: "workspace" } & ImportWorkspace);

/** Distinguishes a construct's host surface. Drives:
 *   - which SDK is bound into tutorial scripts (`it.dc` vs `it.sc`)
 *   - which mutation-heuristic SDK allow-list is applied
 *   - which catalog table the construct is written to
 *   - which `ImportDiagramElement` variant is required as the seed */
export type ConstructKind = "diagram" | "workspace";

// ─── Type guards ────────────────────────────────────────────────
export function isImportDiagramSeed(
  seed: ImportDiagramElement | null | undefined,
): seed is ImportDiagramElement & { kind: "diagram" } {
  return !!seed && seed.kind === "diagram";
}

export function isImportWorkspaceSeed(
  seed: ImportDiagramElement | null | undefined,
): seed is ImportDiagramElement & { kind: "workspace" } {
  return !!seed && seed.kind === "workspace";
}

// ─── Launch-point helpers (replayable workspace constructs) ──────
/** Describes where the persistent Play badge lands after install. */
export type LaunchPointAnchor =
  | { kind: "diagram"; title: string }
  | { kind: "workspace" /* root anchor: the install destination workspace */ };

function diagramIsLaunchPointShapeValid(d: ImportDiagram): boolean {
  // Launch-point diagrams may not carry elements or connections.
  return !(d.elements?.length || d.connections?.length);
}

/** Find the (single) launch-point anchor in a workspace seed. Returns
 *  null when the seed has no `isLaunchPoint:true` marker (caller decides
 *  the default: workspace-root anchor or refuse-to-install). Throws on:
 *    - multiple launch points
 *    - launch-point diagram with elements/connections (invalid shape) */
export function findLaunchPoint(seed: ImportWorkspace): LaunchPointAnchor | null {
  const launchDiagrams = (seed.diagrams ?? []).filter((d) => d.isLaunchPoint);
  const launchSubWs = (seed.workspaces ?? []).filter((w) => w.isLaunchPoint);
  const total = launchDiagrams.length + launchSubWs.length;
  if (total === 0) return null;
  if (total > 1) {
    throw new Error(
      "Workspace seed declares multiple isLaunchPoint anchors; exactly one is allowed.",
    );
  }
  if (launchDiagrams.length === 1) {
    const d = launchDiagrams[0];
    if (!diagramIsLaunchPointShapeValid(d)) {
      throw new Error(
        `Launch-point diagram "${d.title}" must not contain elements or connections — only title/description/variables.`,
      );
    }
    return { kind: "diagram", title: d.title };
  }
  // Sub-workspace anchor — forward-compat; data model does not nest yet.
  return { kind: "workspace" };
}

// ─── Author-time seed validation ────────────────────────────────
// Surface launch-point / shape problems at construct-create / import
// time instead of waiting for an end user to click Install. Called
// from MCP create_construct, set_construct_seed, and ImportTutorial.

export type SeedValidationIssue = { level: "error" | "warning"; message: string };

/** Validate a construct's import_seed against the finalized replayable
 *  model (TutorialImportSpec §15). Returns a flat list of issues —
 *  callers should fail on `level==="error"` entries and surface
 *  `level==="warning"` entries non-fatally.
 *
 *  Rules:
 *   - Seed absent → OK (seed is optional for all workspace constructs;
 *     diagram-target constructs use base_diagram).
 *   - target_kind "diagram"  → if seed present, must be kind "diagram".
 *   - target_kind "workspace" → if seed present, must be kind "workspace".
 *   - Workspace seed: at most one isLaunchPoint:true across
 *     diagrams[] + workspaces[].
 *   - Workspace seed: a launch-point diagram must be an "empty shell"
 *     (no elements, no connections).
 *   - Sub-workspace isLaunchPoint:true → warning (not yet honored at
 *     runtime; sub-workspaces unshipped).
 *   - replayable===false + any isLaunchPoint marker → warning (no Play
 *     badge will be created; flag is ignored).
 */
export function validateConstructSeed(
  seed: ImportDiagramElement | null | undefined,
  opts: { replayable: boolean; targetKind: "diagram" | "workspace" },
): SeedValidationIssue[] {
  const issues: SeedValidationIssue[] = [];
  if (!seed) return issues;

  if (opts.targetKind === "diagram") {
    if (seed.kind !== "diagram") {
      issues.push({
        level: "error",
        message: `target_kind="diagram" requires import_seed.kind="diagram" (got "${seed.kind}").`,
      });
    }
    if (seed.kind === "diagram" && (seed as ImportDiagram).isLaunchPoint) {
      issues.push({
        level: "error",
        message:
          'isLaunchPoint is only valid inside a workspace seed; diagram-target constructs have no launch badge.',
      });
    }
    return issues;
  }

  // target_kind === "workspace"
  if (seed.kind !== "workspace") {
    issues.push({
      level: "error",
      message: `target_kind="workspace" requires import_seed.kind="workspace" (got "${seed.kind}").`,
    });
    return issues;
  }

  const ws = seed as ImportWorkspace;
  const launchDiagrams = (ws.diagrams ?? []).filter((d) => d.isLaunchPoint);
  const launchSubWs = (ws.workspaces ?? []).filter((w) => w.isLaunchPoint);
  const totalAnchors = launchDiagrams.length + launchSubWs.length;

  if (totalAnchors > 1) {
    issues.push({
      level: "error",
      message: `Workspace seed declares ${totalAnchors} isLaunchPoint anchors; at most one is allowed.`,
    });
  }

  for (const d of launchDiagrams) {
    if (!diagramIsLaunchPointShapeValid(d)) {
      issues.push({
        level: "error",
        message: `Launch-point diagram "${d.title}" must be an empty shell (no elements or connections) — move its content into a sibling diagram.`,
      });
    }
  }

  if (launchSubWs.length > 0) {
    issues.push({
      level: "warning",
      message:
        "Sub-workspace isLaunchPoint markers are accepted but not yet honored at runtime (sub-workspaces are not shipped). The Play badge will fall back to the destination workspace card.",
    });
  }

  if (!opts.replayable && totalAnchors > 0) {
    issues.push({
      level: "warning",
      message:
        "isLaunchPoint markers are ignored on non-replayable constructs (no Play badge is created). Drop them or set replayable=true.",
    });
  }

  return issues;
}

/** Convenience: throw if validateConstructSeed produced any errors.
 *  Returns the (possibly empty) warning list. */
export function assertConstructSeedValid(
  seed: ImportDiagramElement | null | undefined,
  opts: { replayable: boolean; targetKind: "diagram" | "workspace" },
): SeedValidationIssue[] {
  const issues = validateConstructSeed(seed, opts);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length > 0) {
    throw new Error(
      `Construct seed validation failed:\n  - ${errors.map((e) => e.message).join("\n  - ")}`,
    );
  }
  return issues.filter((i) => i.level === "warning");
}
