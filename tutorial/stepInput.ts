// Shared normalizer for tutorial step inputs accepted by MCP tools
// (create_archetype, update_archetype_steps). Mirrors the camelCase
// contract documented in src/pages/TutorialImportSpec.tsx so that AI
// callers can paste the same shape they author in JSON imports.
//
// Accepts BOTH camelCase (preferred — matches TutorialImportSpec) and
// snake_case (back-compat with earlier MCP releases). Advanced step-type
// payloads (runScript, forEach, whileCondition, selectTargetElements,
// captureVariable, setVariable, branchOnVariable, choices, detourPrompt,
// cardSize, richContentBase64, plus the discriminator `type`) are folded
// into the `step_metadata` JSON column — same convention used by
// src/pages/ImportTutorial.tsx so the engine reads them identically.
/** Permissive — we hand-pick known fields and pass through extras into
 *  step_metadata so the spec can evolve without redeploying the MCP. */
export type TutorialStepInput = Record<string, unknown>;

const METADATA_KEYS = [
  "type",
  "choices",
  "detourPrompt",
  "cardSize",
  "richContentBase64",
  "captureVariable",
  "setVariable",
  "branchOnVariable",
  "runScript",
  "forEach",
  "whileCondition",
  "selectTargetElements",
] as const;

function pick<T = unknown>(o: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k] as T;
  return undefined;
}

export function buildStepRow(
  tutorialId: string,
  step: Record<string, unknown>,
  fallbackIndex: number,
): Record<string, unknown> {
  const stepIndex = pick<number>(step, "step_index", "stepIndex") ?? fallbackIndex;
  const title = pick<string>(step, "title") ?? "";
  const instruction = pick<string>(step, "instruction") ?? "";
  const targetSelector = pick<string>(step, "target_selector", "targetSelector") ?? "body";
  const completionEvent = pick<string>(step, "completion_event", "completionEvent") ?? "manual_advance";
  const phase = pick<string>(step, "phase") ?? "intro";
  const targetElementName = pick<string>(step, "target_element_name", "targetElementName") ?? null;
  const secondaryElementName = pick<string>(step, "secondary_element_name", "secondaryElementName") ?? null;
  const suggestedValues = pick<Record<string, unknown>>(step, "suggested_values", "suggestedValues") ?? null;
  const modalContent = pick<Record<string, unknown>>(step, "modal_content", "modalContent") ?? null;
  const delayMs = pick<number>(step, "delay_ms", "delayMs") ?? 0;

  // Build step_metadata: start with any explicit step_metadata blob the
  // caller passed, then layer the camelCase advanced fields on top.
  const explicit = pick<Record<string, unknown>>(step, "step_metadata", "stepMetadata");
  const metadata: Record<string, unknown> = { ...(explicit ?? {}) };

  // `type` may be set to "standard" — only persist when meaningful, to
  // match ImportTutorial.tsx behavior.
  const stepType = pick<string>(step, "type");
  if (stepType && stepType !== "standard") metadata.type = stepType;

  for (const k of METADATA_KEYS) {
    if (k === "type") continue; // handled above
    const v = step[k];
    if (v === undefined || v === null) continue;
    if (k === "cardSize" && v === "normal") continue;
    metadata[k] = v;
  }

  return {
    tutorial_id: tutorialId,
    step_index: stepIndex,
    title,
    instruction,
    target_selector: targetSelector,
    completion_event: completionEvent,
    phase,
    target_element_name: targetElementName,
    secondary_element_name: secondaryElementName,
    suggested_values: suggestedValues,
    modal_content: modalContent,
    delay_ms: delayMs,
    step_metadata: Object.keys(metadata).length > 0 ? metadata : null,
  };
}

export function buildStepRows(
  tutorialId: string,
  steps: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return steps.map((s, i) => buildStepRow(tutorialId, s, i));
}
