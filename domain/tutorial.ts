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
  | "select_target_elements";

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
}
