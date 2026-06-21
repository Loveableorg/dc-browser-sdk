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
