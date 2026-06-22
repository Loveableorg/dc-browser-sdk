// Cross-runtime tutorial domain types. Authoritative shapes for:
//   • src/pages/TutorialImportSpec.tsx (browser JSON import + tutorial UI)
//   • supabase/functions/dc-mcp + claude2-mcp (create_archetype, etc.)
//   • supabase/functions/api-v1 (future REST surface)
//   • src/lib/scriptRunner.ts (it.dc tutorial-author scripts)
//
// Pure TypeScript — see _shared/lib/README.md for the cross-runtime rules.
// The Zod schema lives in ../schemas/tutorial.ts. DB row construction
// (camelCase → snake_case + step_metadata folding) lives in
// ../tutorial/stepInput.ts.

import type { VariableDefinitionLike } from "./types.ts";
import type { ConstructKind, ImportDiagramElement } from "./constructImport.ts";

export type { ConstructKind, ImportDiagramElement } from "./constructImport.ts";

export type TutorialStepType =
  | "standard"
  | "branch"
  | "detour"
  | "rich_content"
  | "capture_variable"
  | "set_variable"
  | "branch_on_variable"
  | "run_script"
  | "run_script_async"
  | "for_each"
  | "while_condition"
  | "select_target_elements"
  | "show_source_annotation"
  | "show_element_annotation"
  // ── Workspace-construct primitives (added with constructKind:"workspace") ──
  /** Polls a JS predicate (with `it.dc` + `it.sc` read-helpers in scope)
   *  until it returns truthy or `timeoutMs` elapses. Non-blocking modal
   *  surface with Skip / Abort controls. See `WaitForConditionPayload`. */
  | "wait_for_condition"
  /** Workspace analog of `select_target_elements`. Modal picker over the
   *  workspaces the user owns/admins; optional inline-create.
   *  See `SelectWorkspaceTargetPayload`. */
  | "select_workspace_target"
  /** Iterator sugar: resolves a workspace ref, then iterates every diagram
   *  in it, exposing each as `it.<asVar> = { id, title }` to `bodySteps`.
   *  See `ForEachDiagramInWorkspacePayload`. */
  | "for_each_diagram_in_workspace"
  /** Navigates the current tab (or opens a new tab) to a diagram identified
   *  by a UUID, a session-variable name, or `{ id }`. Non-mutating. See
   *  `OpenDiagramPayload`. */
  | "open_diagram"
  /** Symmetric to `open_diagram` — navigates back to a workspace view
   *  (overview / constructs / activity / variables). Non-mutating. See
   *  `ReturnToWorkspacePayload`. */
  | "return_to_workspace";


export type TutorialPhase = "intro" | "guided_project";

export interface TutorialModalContent {
  heading: string;
  body?: string;
  buttonLabel?: string;
}

export interface TutorialChoice {
  label: string;
  description: string;
  iconName?: string;
  steps: TutorialStep[];
}

export interface RunScriptPayload {
  script: string;
  captureResultAs?: string;
  timeoutMs?: number;
  onError?: "halt" | "continue";
  modal?: { heading?: string; cancelLabel?: string; minimizeLabel?: string };
  requireAck?: boolean;
  ackButtonLabel?: string;
  imports?: string[];
}

export interface ForEachPayload {
  items: string;
  asVar: string;
  indexVar?: string;
  bodySteps: TutorialStep[];
  maxIterations?: number;
}

export interface WhileConditionPayload {
  condition: string;
  bodySteps: TutorialStep[];
  maxIterations?: number;
}

/**
 * Payload for `wait_for_condition`. Polls `predicate` (a JS expression or
 * statement that evaluates to a truthy/falsy value) every `pollMs` until
 * truthy OR `timeoutMs` elapses. The predicate runs in the same sandbox as
 * `run_script` BUT only read-side SDK methods are exposed (see
 * `DC_SDK_READONLY_METHODS` / `SC_SDK_READONLY_METHODS`); attempting to
 * call a write method throws and the predicate is treated as falsy.
 *
 *   • `onTimeout: "halt"` (default) — aborts the tutorial with an error.
 *   • `onTimeout: "continue"`        — advances to the next step.
 *   • `onTimeout: "branch"`          — requires `choices` (like a `branch`
 *                                       step); choiceIndex 0 = met,
 *                                       1 = timed out.
 *   • `allowSkip` adds a "Skip" button (skipping counts as met for
 *      branching, but writes `it.<captureMetAs> = false` if set).
 */
export interface WaitForConditionPayload {
  predicate: string;
  pollMs?: number;
  timeoutMs?: number;
  onTimeout?: "halt" | "continue" | "branch";
  modal?: { heading?: string; body?: string; skipLabel?: string; abortLabel?: string };
  allowSkip?: boolean;
  captureMetAs?: string;
  imports?: string[];
}

/** Payload for `select_workspace_target`. Workspace analog of
 *  `SelectTargetElementsPayload`. Picker shows workspaces where the user
 *  has the listed `roles` (default `["owner","admin"]`). Result is written
 *  to `variableName` as `[{ id, name }]` (multi) or `{ id, name }` (single). */
export interface SelectWorkspaceTargetPayload {
  variableName: string;
  mode: "single" | "multiple";
  minCount?: number;
  maxCount?: number;
  roles?: Array<"owner" | "admin" | "editor" | "viewer">;
  /** When true, the picker shows an inline "Create new workspace" form. */
  allowCreate?: boolean;
  title?: string;
  intro?: string;
  buttonLabel?: string;
}

/** Payload for `open_diagram` — navigation step. Non-mutating; allowed in
 *  read-only replayable archetypes. `diagramRef` accepts a UUID string,
 *  a session-variable name (resolved against `it.*`), or `{ id }`. */
export interface OpenDiagramPayload {
  diagramRef: string | { id: string; title?: string };
  mode?: "same_tab" | "new_tab";
  requireUserClick?: boolean;
}

/** Payload for `return_to_workspace` — navigation step symmetric to
 *  `open_diagram`. When `workspaceRef` is omitted, falls back to the
 *  workspace bound to `it.sc` (or the current diagram's workspace_id). */
export interface ReturnToWorkspacePayload {
  workspaceRef?: string | { id: string };
  view?: "overview" | "diagrams" | "constructs" | "activity" | "variables";
  requireUserClick?: boolean;
}


/** Payload for `for_each_diagram_in_workspace`. Resolves `workspaceRef`
 *  (variable name, workspace id, or `{ id }` object) and iterates every
 *  diagram inside it. `bodySteps` see `it.<asVar> = { id, title }`. */
export interface ForEachDiagramInWorkspacePayload {
  workspaceRef: string;
  asVar: string;
  indexVar?: string;
  bodySteps: TutorialStep[];
  maxIterations?: number;
}

export interface SelectTargetElementsGroup {
  key: string;
  label: string;
  prompt?: string;
  mode: "single" | "multiple";
  minCount?: number;
  maxCount?: number;
  newElementNameHint?: string;
}

export interface SelectTargetElementsPayload {
  variableName: string;
  groups: SelectTargetElementsGroup[];
  scope?: "drop_scope" | "whole_diagram";
  title?: string;
  intro?: string;
  buttonLabel?: string;
}

export interface BranchOnVariableRule {
  when: {
    var: string;
    equals?: string | number | boolean;
    in?: Array<string | number | boolean>;
    contains?: string | number | boolean;
  };
  choiceIndex: number;
}

export interface CaptureVariablePayload {
  variable: VariableDefinitionLike;
  prompt?: string;
  buttonLabel?: string;
}

/**
 * Canonical camelCase shape consumed everywhere. The Zod schema and
 * `buildStepRow` accept legacy snake_case aliases for back-compat; this
 * type only carries the canonical form.
 */
export interface TutorialStep {
  type?: TutorialStepType;
  /** Optional — when omitted, ordering is taken from array index. */
  stepIndex?: number;
  title: string;
  instruction: string;
  targetSelector: string;
  completionEvent: string;
  phase: TutorialPhase;
  targetElementName?: string | null;
  secondaryElementName?: string | null;
  suggestedValues?: Record<string, unknown> | null;
  modalContent?: TutorialModalContent | null;
  delayMs?: number;
  cardSize?: "normal" | "large" | "wide";
  detourPrompt?: string;
  richContentBase64?: string;
  /**
   * Render format for `richContentBase64`. Defaults to `"markdown"` for
   * back-compat. Set to `"html"` to render the decoded payload inside a
   * locked-down sandboxed iframe (full HTML document srcDoc). Set to
   * `"jsx"` to ship a single-file React component (must `export default`
   * a component) — the host transforms it with Babel-standalone and
   * renders it via react@18 inside the same sandbox. Used by tutorial
   * authors who want fully custom interactive explainers; sandboxed so
   * the embedded code can't reach the host app's storage or auth.
   */
  richContentFormat?: "markdown" | "html" | "jsx";
  choices?: TutorialChoice[];
  captureVariable?: CaptureVariablePayload;
  setVariable?: { name: string; value: unknown; reason?: string };
  branchOnVariable?: { rules: BranchOnVariableRule[]; defaultChoiceIndex?: number };
  runScript?: RunScriptPayload;
  forEach?: ForEachPayload;
  whileCondition?: WhileConditionPayload;
  selectTargetElements?: SelectTargetElementsPayload;
  waitForCondition?: WaitForConditionPayload;
  selectWorkspaceTarget?: SelectWorkspaceTargetPayload;
  forEachDiagramInWorkspace?: ForEachDiagramInWorkspacePayload;
  openDiagram?: OpenDiagramPayload;
  returnToWorkspace?: ReturnToWorkspacePayload;

  /** Pre-baked JSONB blob — merged underneath the camelCase fields. */
  stepMetadata?: Record<string, unknown> | null;
}

/** Payload for creating a tutorial/archetype (custom_tutorials row + steps). */
export interface CreateTutorialPayload {
  topicId?: string;
  label: string;
  description?: string;
  author?: string | null;
  iconName?: string;
  color?: string;
  categoryId?: string | null;
  diagramTitle?: string;
  tips?: string[];
  variableDefinitions?: VariableDefinitionLike[];
  baseDiagram?: Record<string, unknown> | null;
  /**
   * Optional structured seed payload (preferred over legacy `baseDiagram`).
   * Discriminated union:
   *   - `{ kind: "diagram",   ... ImportDiagram   }` — single host diagram
   *     scaffolded under the chosen parent element. Required shape for
   *     diagram-bound constructs (`constructKind: "diagram"`).
   *   - `{ kind: "workspace", ... ImportWorkspace }` — seeds a workspace
   *     with any number of diagrams (and, when the data model supports it,
   *     nested workspaces / folders). Required shape for workspace
   *     constructs (`constructKind: "workspace"`).
   * See `_shared/lib/domain/constructImport.ts`.
   */
  seed?: ImportDiagramElement | null;
  /**
   * Construct host surface — drives which SDK is bound into tutorial
   * scripts (`it.dc` for "diagram", `it.sc` for "workspace"), which
   * mutation-heuristic allow-list applies, and which catalog table the
   * row is written to. Defaults to "diagram" for back-compat.
   */
  constructKind?: ConstructKind;
  steps?: TutorialStep[];
  isArchetype?: boolean;
  /** Defaults to false for archetypes created via MCP. */
  isVisible?: boolean;
  /**
   * Replayable Archetypes (Presentation Mode). When true (only valid with
   * isArchetype:true) the archetype is launched via a ▶ play button rendered
   * on the scaffolded subtree root — it does NOT auto-start when the diagram
   * opens, and it can be replayed any number of times. See §14 of the
   * Construct Import Specification for the full authoring guide.
   *
   * Workspace role visibility: the play button is visible to every viewer
   * (incl. read-only). Whether they can actually play is gated by
   * hasMutations (see `hasMutationsHint`).
   */
  replayable?: boolean;
  /**
   * Three-way author contract for the mutation flag. The server ALWAYS
   * derives `has_mutations` from the step list via
   * `_shared/lib/tutorial/mutationHeuristic.ts`; this hint controls how
   * the derived value is reconciled with the author's declaration:
   *
   *   - `null`/omitted: server decides via the heuristic (recommended).
   *   - `true`:  conservative override — declared mutating regardless of
   *              heuristic. Use when scripts produce external side effects
   *              the heuristic can't see (HTTP calls, etc.). Restricts
   *              playback to editors.
   *   - `false`: author asserts read-only. If the heuristic detects ANY
   *              mutating step (or any `it.dc.*` / `it.sc.*` use outside
   *              its read-only allow-list), `createTutorial` throws a
   *              ValidationError. On success the construct is playable
   *              by read-only workspace viewers.
   */
  hasMutationsHint?: boolean | null;
}

export interface UpdateTutorialPatch {
  label?: string;
  description?: string;
  author?: string | null;
  iconName?: string;
  color?: string;
  categoryId?: string | null;
  diagramTitle?: string;
  tips?: string[];
  variableDefinitions?: VariableDefinitionLike[];
  baseDiagram?: Record<string, unknown> | null;
  isArchetype?: boolean;
  isVisible?: boolean;
  /** Toggle Presentation Mode on an existing archetype. See CreateTutorialPayload.replayable. */
  replayable?: boolean;
}

