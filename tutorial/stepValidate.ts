// Tutorial step validator — used by MCP create_construct, create_archetype,
// and update_archetype_steps to give authors actionable feedback when a
// step payload is malformed BEFORE it lands in *_construct_steps rows.
//
// Intentionally lighter-weight than a Zod discriminated union: the step
// surface is wide and evolves often (see TutorialImportSpec.tsx). We
// check the small set of fields that, if missing/wrong, will silently
// break runtime behavior (a step card with no modal, an unknown completion
// event the runtime will never fire, a script step with no script body,
// etc.). Anything else flows through as a warning.

export interface StepValidationIssue {
  index: number;
  stepTitle?: string;
  type?: string;
  field?: string;
  message: string;
}

export interface StepValidationReport {
  errors: StepValidationIssue[];
  warnings: StepValidationIssue[];
}

const KNOWN_STEP_TYPES = new Set<string>([
  "standard",
  "branch",
  "detour",
  "rich_content",
  "capture_variable",
  "set_variable",
  "branch_on_variable",
  "run_script",
  "run_script_async",
  "for_each",
  "while_condition",
  "select_target_elements",
  "show_source_annotation",
  "show_element_annotation",
  "wait_for_condition",
  "select_workspace_target",
  "for_each_diagram_in_workspace",
  "open_diagram",
  "return_to_workspace",
  "add_archetype",
  "trigger_construct",
  "close_panel",
]);

// Completion events known to the runtime. Keep in sync with the
// TutorialCompletionEvent union in src/components/tutorial/tutorialSteps.ts —
// unknown values are warnings (the step will never auto-advance unless the
// author wires a custom emitter).
const KNOWN_COMPLETION_EVENTS = new Set<string>([
  // Generic / system
  "manual_advance",
  "text_modal_dismissed",
  "branch_selected",
  // Variables
  "variable_captured",
  "variable_set",
  "variable_branch_resolved",
  // Script / iteration / wait
  "script_completed",
  "iteration_completed",
  "condition_met",
  // Selection / annotation
  "targets_selected",
  "source_annotation_dismissed",
  "element_annotation_dismissed",
  // Workspace flow
  "workspace_target_selected",
  "workspace_iteration_completed",
  "diagram_opened",
  "workspace_view_opened",
  // Element / connection mutation
  "element_added",
  "element_dragged",
  "element_expanded",
  "element_saved",
  "element_deleted",
  "element_duplicated",
  "element_relocated",
  "element_ejected",
  "element_nested",
  "sub_element_added",
  "drilled_down",
  "breadcrumb_navigated",
  "connection_added",
  "connection_edited",
  "connection_deleted",
  "connections_imported",
  "color_changed",
  "description_added",
  "edit_opened",
  "share_toggled",
  "fit_to_content",
  // Source / IDE / refs
  "source_code_attached",
  "source_attached_at_path",
  "project_root_set",
  "json_imported",
  "git_fetched",
  "ide_opened",
  "ide_file_selected",
  "ide_saved",
  "ide_reverted",
  "library_imported",
  "ask_ai_opened",
  "markdown_viewed",
  "mermaid_viewed",
  "settings_opened",
  "diagram_ref_added",
  "menu_opened",
  "menu_item_clicked",
  // Path-based scaffolding
  "scope_navigated",
  "tree_scaffolded",
  // Archetype / construct
  "archetype_added",
  "construct_triggered",
  "panel_closed",
  // Legacy aliases still emitted by older steps — accept without warning
  "annotation_dismissed",
  "source_attached",
  "source_updated",
  "element_created",
  "element_updated",
  "branch_resolved",
  "workspace_returned",
]);

function pick<T = unknown>(o: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k] as T;
  return undefined;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

export function validateTutorialStep(
  step: Record<string, unknown>,
  index: number,
): StepValidationReport {
  const errors: StepValidationIssue[] = [];
  const warnings: StepValidationIssue[] = [];
  const titleStr = pick<string>(step, "title");
  const type = pick<string>(step, "type") ?? "standard";
  const push = (
    bucket: StepValidationIssue[],
    field: string | undefined,
    message: string,
  ) => bucket.push({ index, stepTitle: titleStr, type, field, message });

  // ── core fields ────────────────────────────────────────────────
  if (!isNonEmptyString(titleStr)) {
    push(warnings, "title", "Step has no title — UI will show an empty header.");
  }
  if (!isNonEmptyString(pick<string>(step, "instruction"))) {
    push(warnings, "instruction", "Step has no instruction — coach card body will be empty.");
  }

  if (!KNOWN_STEP_TYPES.has(type)) {
    push(
      errors,
      "type",
      `Unknown step type "${type}". Known: ${[...KNOWN_STEP_TYPES].sort().join(", ")}.`,
    );
  }

  const completionEvent =
    pick<string>(step, "completion_event", "completionEvent") ?? "manual_advance";
  if (!KNOWN_COMPLETION_EVENTS.has(completionEvent)) {
    push(
      warnings,
      "completionEvent",
      `Unknown completion_event "${completionEvent}" — runtime won't auto-advance unless something emits it.`,
    );
  }

  // ── per-type payload checks ────────────────────────────────────
  switch (type) {
    case "capture_variable": {
      const cv = pick<Record<string, unknown>>(step, "captureVariable", "capture_variable");
      if (!isObject(cv)) {
        push(errors, "captureVariable", "capture_variable step requires a `captureVariable` payload.");
        break;
      }
      const variable = pick<Record<string, unknown>>(cv, "variable");
      if (!isObject(variable) || !isNonEmptyString(pick<string>(variable, "name"))) {
        push(errors, "captureVariable.variable.name", "capture_variable requires captureVariable.variable.name.");
      }
      if (completionEvent !== "variable_captured") {
        push(
          warnings,
          "completionEvent",
          `capture_variable steps normally use completion_event:"variable_captured" (got "${completionEvent}").`,
        );
      }
      break;
    }
    case "set_variable": {
      const sv = pick<Record<string, unknown>>(step, "setVariable", "set_variable");
      if (!isObject(sv)) {
        push(errors, "setVariable", "set_variable step requires a `setVariable` payload.");
        break;
      }
      if (!isNonEmptyString(pick<string>(sv, "variable", "name"))) {
        push(errors, "setVariable.variable", "set_variable requires setVariable.variable (target variable name).");
      }
      break;
    }
    case "branch_on_variable": {
      const bv = pick<Record<string, unknown>>(step, "branchOnVariable", "branch_on_variable");
      if (!isObject(bv)) {
        push(errors, "branchOnVariable", "branch_on_variable step requires a `branchOnVariable` payload.");
        break;
      }
      // Runtime shape (src/lib/template/branch.ts): { rules: BranchRule[], defaultChoiceIndex?: number }.
      // Each rule is either { expression, choiceIndex } or { when: { var, equals|in|contains }, choiceIndex }.
      const rules = pick<unknown[]>(bv, "rules");
      if (!isArray(rules) || rules.length === 0) {
        push(
          errors,
          "branchOnVariable.rules",
          "branch_on_variable requires branchOnVariable.rules (non-empty array of { when|expression, choiceIndex }).",
        );
      }
      break;
    }
    case "branch":
    case "detour": {
      const choices = pick<unknown[]>(step, "choices");
      if (!isArray(choices) || choices.length === 0) {
        push(
          errors,
          "choices",
          `${type} step requires a non-empty \`choices\` array (each choice has label, description, steps[]).`,
        );
      }
      break;
    }
    case "run_script":
    case "run_script_async": {
      const rs = pick<Record<string, unknown>>(step, "runScript", "run_script");
      if (!isObject(rs)) {
        push(errors, "runScript", `${type} step requires a \`runScript\` payload.`);
        break;
      }
      if (!isNonEmptyString(pick<string>(rs, "script"))) {
        push(errors, "runScript.script", `${type} requires runScript.script (non-empty source string).`);
      }
      if (completionEvent !== "script_completed") {
        push(
          warnings,
          "completionEvent",
          `${type} steps normally use completion_event:"script_completed" (got "${completionEvent}").`,
        );
      }
      break;
    }
    case "for_each": {
      const fe = pick<Record<string, unknown>>(step, "forEach", "for_each");
      if (!isObject(fe)) {
        push(errors, "forEach", "for_each step requires a `forEach` payload.");
        break;
      }
      const hasSource =
        pick(fe, "items") !== undefined ||
        isNonEmptyString(pick<string>(fe, "itemsExpr", "items_expr")) ||
        isNonEmptyString(pick<string>(fe, "itemsVariable", "items_variable"));
      if (!hasSource) {
        push(
          errors,
          "forEach.items",
          "for_each requires forEach.items, forEach.itemsExpr, or forEach.itemsVariable.",
        );
      }
      const steps = pick<unknown[]>(fe, "steps", "bodySteps", "body_steps");
      if (!isArray(steps) || steps.length === 0) {
        push(errors, "forEach.steps", "for_each requires forEach.steps (non-empty array of nested steps).");
      }
      break;
    }
    case "while_condition": {
      const wc = pick<Record<string, unknown>>(step, "whileCondition", "while_condition");
      if (!isObject(wc)) {
        push(errors, "whileCondition", "while_condition step requires a `whileCondition` payload.");
        break;
      }
      if (!isNonEmptyString(pick<string>(wc, "condition"))) {
        push(errors, "whileCondition.condition", "while_condition requires whileCondition.condition (JS expression string).");
      }
      const steps = pick<unknown[]>(wc, "steps", "bodySteps", "body_steps");
      if (!isArray(steps) || steps.length === 0) {
        push(errors, "whileCondition.steps", "while_condition requires whileCondition.steps (non-empty array).");
      }
      break;
    }
    case "select_target_elements": {
      const st = pick<Record<string, unknown>>(step, "selectTargetElements", "select_target_elements");
      if (!isObject(st)) {
        push(errors, "selectTargetElements", "select_target_elements step requires a `selectTargetElements` payload.");
        break;
      }
      if (!isNonEmptyString(pick<string>(st, "variableName", "variable_name"))) {
        push(errors, "selectTargetElements.variableName", "select_target_elements requires selectTargetElements.variableName.");
      }
      break;
    }
    case "show_source_annotation":
    case "show_element_annotation": {
      const key = type === "show_source_annotation" ? "showSourceAnnotation" : "showElementAnnotation";
      const snake = type;
      const ann = pick<Record<string, unknown>>(step, key, snake);
      if (!isObject(ann)) {
        push(errors, key, `${type} step requires a \`${key}\` payload.`);
        break;
      }
      if (!isNonEmptyString(pick<string>(ann, "bubbleText", "bubble_text"))) {
        push(errors, `${key}.bubbleText`, `${type} requires ${key}.bubbleText.`);
      }
      if (pick<string>(ann, "elementPath", "element_path") === undefined) {
        push(warnings, `${key}.elementPath`, `${type} usually needs ${key}.elementPath to anchor the bubble.`);
      }
      break;
    }
    case "wait_for_condition": {
      const wc = pick<Record<string, unknown>>(step, "waitForCondition", "wait_for_condition");
      if (!isObject(wc) || !isNonEmptyString(pick<string>(wc, "condition"))) {
        push(errors, "waitForCondition.condition", "wait_for_condition requires waitForCondition.condition (JS expression string).");
      }
      break;
    }
    case "open_diagram": {
      const od = pick<Record<string, unknown>>(step, "openDiagram", "open_diagram");
      if (!isObject(od)) {
        push(errors, "openDiagram", "open_diagram step requires an `openDiagram` payload.");
        break;
      }
      if (
        !isNonEmptyString(pick<string>(od, "diagramVariable", "diagram_variable")) &&
        !isNonEmptyString(pick<string>(od, "diagramId", "diagram_id"))
      ) {
        push(errors, "openDiagram.diagramVariable", "open_diagram requires openDiagram.diagramVariable or openDiagram.diagramId.");
      }
      break;
    }
    case "select_workspace_target": {
      const swt = pick<Record<string, unknown>>(step, "selectWorkspaceTarget", "select_workspace_target");
      if (!isObject(swt) || !isNonEmptyString(pick<string>(swt, "variableName", "variable_name"))) {
        push(errors, "selectWorkspaceTarget.variableName", "select_workspace_target requires selectWorkspaceTarget.variableName.");
      }
      break;
    }
    case "for_each_diagram_in_workspace": {
      const fe = pick<Record<string, unknown>>(step, "forEachDiagramInWorkspace", "for_each_diagram_in_workspace");
      if (!isObject(fe)) {
        push(errors, "forEachDiagramInWorkspace", "for_each_diagram_in_workspace step requires a `forEachDiagramInWorkspace` payload.");
        break;
      }
      const steps = pick<unknown[]>(fe, "steps", "bodySteps", "body_steps");
      if (!isArray(steps) || steps.length === 0) {
        push(errors, "forEachDiagramInWorkspace.steps", "for_each_diagram_in_workspace requires non-empty steps.");
      }
      break;
    }
    case "add_archetype": {
      const ap = pick<Record<string, unknown>>(step, "addArchetype", "add_archetype");
      if (!isObject(ap)) {
        push(errors, "addArchetype", "add_archetype step requires an `addArchetype` payload.");
        break;
      }
      if (
        !isNonEmptyString(pick<string>(ap, "archetypeTopicId", "archetype_topic_id")) &&
        !isNonEmptyString(pick<string>(ap, "archetypeId", "archetype_id"))
      ) {
        push(errors, "addArchetype.archetypeTopicId", "add_archetype requires addArchetype.archetypeTopicId or addArchetype.archetypeId.");
      }
      break;
    }
    case "trigger_construct": {
      const tc = pick<Record<string, unknown>>(step, "triggerConstruct", "trigger_construct");
      if (!isObject(tc)) {
        push(errors, "triggerConstruct", "trigger_construct step requires a `triggerConstruct` payload.");
        break;
      }
      const hasInstall = isNonEmptyString(pick<string>(tc, "installId", "install_id"));
      const lane = pick<string>(tc, "lane");
      const constructId = pick<string>(tc, "constructId", "construct_id");
      const wsId = pick<string>(tc, "workspaceId", "workspace_id");
      if (!hasInstall && !(isNonEmptyString(lane) && isNonEmptyString(constructId) && isNonEmptyString(wsId))) {
        push(errors, "triggerConstruct", "trigger_construct requires either installId, or (lane + constructId + workspaceId).");
      }
      break;
    }
    case "close_panel": {
      const cp = pick<Record<string, unknown>>(step, "closePanel", "close_panel");
      if (!isObject(cp)) {
        push(errors, "closePanel", "close_panel step requires a `closePanel` payload.");
        break;
      }
      const target = pick<string>(cp, "target");
      const validTargets = ["ide", "ask_ai", "variables", "chat", "run", "all"];
      if (!isNonEmptyString(target) || !validTargets.includes(target)) {
        push(
          errors,
          "closePanel.target",
          `close_panel.target must be one of: ${validTargets.join(", ")}.`,
        );
      }
      break;
    }
    case "rich_content": {
      const hasBase64 = isNonEmptyString(pick<string>(step, "richContentBase64", "rich_content_base64"));
      const hasPlain = isNonEmptyString(
        pick<string>(step, "richContent", "rich_content", "richContentText", "rich_content_text"),
      );
      if (!hasBase64 && !hasPlain) {
        push(errors, "richContentBase64", "rich_content step requires richContent (plaintext) or richContentBase64.");
      }
      if (completionEvent !== "text_modal_dismissed") {
        push(
          warnings,
          "completionEvent",
          `rich_content steps normally use completion_event:"text_modal_dismissed" (got "${completionEvent}").`,
        );
      }
      break;
    }
  }

  return { errors, warnings };
}

export function validateTutorialSteps(
  steps: Array<Record<string, unknown>>,
): StepValidationReport {
  const errors: StepValidationIssue[] = [];
  const warnings: StepValidationIssue[] = [];
  for (let i = 0; i < steps.length; i++) {
    const r = validateTutorialStep(steps[i] ?? {}, i);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }
  return { errors, warnings };
}

/** Format an issue list as a human-readable bullet block for MCP failTxt. */
export function formatIssues(issues: StepValidationIssue[]): string {
  return issues
    .map((i) => {
      const head = `step #${i.index}${i.stepTitle ? ` "${i.stepTitle}"` : ""} (${i.type ?? "standard"})`;
      const field = i.field ? ` [${i.field}]` : "";
      return `• ${head}${field}: ${i.message}`;
    })
    .join("\n");
}
