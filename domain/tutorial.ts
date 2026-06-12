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
  | "show_element_annotation";

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
  steps?: TutorialStep[];
  isArchetype?: boolean;
  /** Defaults to false for archetypes created via MCP. */
  isVisible?: boolean;
  /**
   * Replayable Archetypes (Presentation Mode). When true (only valid with
   * isArchetype:true) the archetype is launched via a ▶ play button rendered
   * on the scaffolded subtree root — it does NOT auto-start when the diagram
   * opens, and it can be replayed any number of times. See §14 of the
   * Tutorial Import Specification for the full authoring guide.
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
   *              mutating step (or any `it.dc.*` use inside a script),
   *              `createTutorial` throws a ValidationError —
   *              "has_mutations was declared false, but the step list
   *              contains diagram-mutating operations". On success the
   *              archetype is playable by read-only workspace viewers.
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

