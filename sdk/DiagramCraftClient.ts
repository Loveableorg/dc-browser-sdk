// DiagramCraftClient — transport-agnostic SDK over the shared diagram core.
//
// Phase 3 of the shared-monorepo rollout. Wraps the same mutation primitives
// the MCP and (upcoming) api-v1 REST function consume, but presents a
// stateful, ergonomic API for tutorial scripts and downstream consumers.
//
// Hard rules (see _shared/lib/README.md):
//   - Pure TS, universal APIs only.
//   - Transport-agnostic: caller supplies a SupabaseClient. Runs with
//     whatever privileges that client carries (anon = browser RLS as user,
//     service role = elevated edge access). No privilege escalation here.
//   - Explicit .ts extensions on every relative import.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.49.1";
import type {
  ImportConnection,
  ImportElement,
  ImportVariable,
} from "../domain/types.ts";
import type { TutorialStep } from "../domain/tutorial.ts";
import {
  deleteElementSubtree,
  insertConnections,
  insertElementTree,
  insertVariables,
  mergeChildrenTree,
  normalizeBaseDiagram,
  resolveElementByPath,
  resolveParentByPath,
} from "../diagram/tree.ts";
import {
  deepSearch,
  searchWorkspace,
  type DeepSearchOptions,
  type SearchHit,
  type SearchOptions,
} from "../diagram/searchWorkspace.ts";
import { ensureBase64 } from "../encoding/base64.ts";

import { NotFoundError, ValidationError } from "../errors/index.ts";
import { buildStepRows, stripClientKind } from "../tutorial/stepInput.ts";
import { tutorialMutatesDiagram } from "../tutorial/mutationHeuristic.ts";
import {
  addArchetypeCore,
  type AddArchetypeCoreResult,
  type ConstructLane,
} from "../archetype/addArchetype.ts";

/**
 * Replayable archetypes REQUIRE a base_diagram with at least one element.
 * The play button is rendered on the scaffolded element; without one there
 * is no host for the button and `add_archetype_to_diagram` would silently
 * create an orphan tutorial_sessions row that the user can never trigger.
 * Throws ValidationError so the create/update call fails loudly.
 */
export function assertReplayableHasBase(
  replayable: boolean,
  baseDiagram: unknown,
): void {
  if (!replayable) return;
  const { elements } = normalizeBaseDiagram(baseDiagram);
  if (!elements.length) {
    throw new ValidationError(
      "Replayable archetypes require a base_diagram with at least one element. " +
      "The play button is anchored to the scaffolded root element — without one " +
      "the archetype has no host and users cannot trigger it. Add at least one " +
      "element to base_diagram (e.g. `{ elements: [{ name: \"My Guide\" }] }`) " +
      "or set replayable=false to author a normal auto-start tutorial.",
    );
  }
}


/**
 * Optional callback invoked after every successful mutation so that
 * tutorial-driven SDK use (`it.dc.*`, `it.sc.*`) and other browser/edge
 * surfaces show up in the diagram activity log alongside direct UI edits.
 * Fire-and-forget; failures must never bubble up. See `sdkBrowser.ts`
 * for the canonical browser wiring to `logActivity()`.
 */
export type SdkActivityLogger = (
  evt: {
    diagramId: string;
    eventType: string;
    targetKind?: string | null;
    targetId?: string | null;
    targetLabel?: string | null;
    payload?: Record<string, unknown>;
  },
) => void | Promise<void>;

export interface DiagramCraftClientOptions {
  /** Optional default diagram id; methods accept an override per call. */
  diagramId?: string;
  /** Audit hook — see SdkActivityLogger. Optional. */
  activityLogger?: SdkActivityLogger;
}

/**
 * Stateful SDK bound to a Supabase client (and optionally a default diagram).
 * Mirrors the MCP tool surface but throws typed `DomainError`s on failure.
 */
export class DiagramCraftClient {
  constructor(
    protected readonly sb: SupabaseClient,
    protected readonly opts: DiagramCraftClientOptions = {},
  ) {}

  /** Return a new client bound to a specific diagram id. */
  withDiagram(diagramId: string): DiagramCraftClient {
    return new DiagramCraftClient(this.sb, { ...this.opts, diagramId });
  }

  /** Fire-and-forget audit emit (no-op when no logger was wired). */
  protected logActivity(
    evt: {
      diagramId: string;
      eventType: string;
      targetKind?: string | null;
      targetId?: string | null;
      targetLabel?: string | null;
      payload?: Record<string, unknown>;
    },
  ): void {
    const fn = this.opts.activityLogger;
    if (!fn) return;
    try {
      const r = fn(evt);
      if (r && typeof (r as Promise<unknown>).then === "function") {
        (r as Promise<unknown>).catch(() => {});
      }
    } catch {
      /* never fail mutations because of audit issues */
    }
  }

  protected requireDiagramId(diagramId?: string): string {
    const id = diagramId ?? this.opts.diagramId;
    if (!id) {
      throw new ValidationError(
        "diagramId is required (pass to method or use withDiagram())",
      );
    }
    return id;
  }

  // ─── Reads ─────────────────────────────────────────────────────
  async getElement(path: string, diagramId?: string) {
    const id = this.requireDiagramId(diagramId);
    return await resolveElementByPath(this.sb, id, path);
  }

  /**
   * Return the row + (decoded) source_code text for the element at `path`.
   * Source is returned as UTF-8 text by default; pass asBase64=true to keep
   * the raw stored payload.
   */
  async getSourceCode(
    path: string,
    opts: { asBase64?: boolean; diagramId?: string } = {},
  ): Promise<{ content: string; filename: string | null }> {
    const diagramId = this.requireDiagramId(opts.diagramId);
    const { id } = await resolveElementByPath(this.sb, diagramId, path);
    const { data } = await this.sb
      .from("diagram_elements")
      .select("source_code_id, element_source_code:source_code_id(source_code, file_name)")
      .eq("id", id)
      .maybeSingle();
    // PostgREST returns the embedded relation as either an object or a
    // single-element array depending on the relationship cardinality the
    // type generator inferred. Normalize.
    const raw = (data as unknown as { element_source_code?: unknown })?.element_source_code;
    const sc = (Array.isArray(raw) ? raw[0] : raw) as
      | { source_code: string; file_name: string | null }
      | undefined;
    if (!sc) {
      throw new NotFoundError(`No source_code attached at "${path}"`, { path });
    }
    const content = opts.asBase64
      ? sc.source_code
      : decodeUtf8Base64(sc.source_code);
    return { content, filename: sc.file_name };
  }

  /**
   * Return the locality-first resolved variable scope at `path` (or
   * diagram-wide when omitted). Mirrors the MCP `get_resolved_scope`
   * tool — see `resolveScope` in tools/variables.ts for shape details.
   * Use this from tutorial scripts to inspect what `it.*` would
   * contain at any element without running the template engine.
   */
  async getResolvedScope(
    path?: string | null,
    diagramId?: string,
  ) {
    const id = this.requireDiagramId(diagramId);
    const { resolveScope } = await import("../diagram/scope.ts");
    return await resolveScope(this.sb, id, path ?? null);
  }

  // ─── Search ─────────────────────────────────────────────────────
  /**
   * Workspace- or diagram-scoped substring search across diagram
   * title/description, element name/description, source filename + decoded
   * body, and variable names + recursive JSON values. Returns compact hits
   * with element_path + value_path so the caller can drill in via
   * getElement / getSourceCode. Caller enforces access (the underlying
   * lib does not).
   */
  async searchWorkspace(
    opts: Omit<SearchOptions, "diagram_ids"> & { workspaceId?: string; diagramId?: string },
  ): Promise<{ hits: SearchHit[]; truncated: boolean; diagrams_searched: number }> {
    return await searchWorkspace(this.sb, {
      ...opts,
      workspace_id: opts.workspaceId ?? opts.workspace_id,
      diagram_id: opts.diagramId ?? opts.diagram_id ?? this.opts.diagramId,
    });
  }

  /**
   * Cross-workspace "deep search" across every diagram the caller can read.
   * Pass include/exclude workspace ids to narrow. When this SDK is
   * constructed with a service-role client, also pass `userId` so the
   * accessible-diagrams set is resolved correctly (owned + workspace-
   * member-shared). With a user-scoped client RLS handles it.
   */
  async deepSearch(
    opts: DeepSearchOptions & { userId?: string },
  ): Promise<{ hits: SearchHit[]; truncated: boolean; diagrams_searched: number; workspaces_searched: number }> {
    return await deepSearch(this.sb, {
      ...opts,
      user_id: opts.userId ?? opts.user_id,
    });
  }






  // ─── Mutations ─────────────────────────────────────────────────
  /**
   * Insert a tree of elements under an optional parent path. Returns the
   * name→id map (for follow-up connection inserts) and root element ids.
   */
  async insertTree(
    elements: ImportElement[],
    opts: { parentPath?: string | null; diagramId?: string } = {},
  ) {
    const diagramId = this.requireDiagramId(opts.diagramId);
    const parentId = await resolveParentByPath(this.sb, diagramId, opts.parentPath);
    const res = await insertElementTree(this.sb, diagramId, parentId, elements);
    // Flush per-element scoped variables + pending connections that
    // insertElementTree defers to the caller. Without this, `variables:[...]`
    // and inline `connections:[...]` on subtree elements silently drop.
    if (res.pendingConnections.length) {
      await insertConnections(this.sb, diagramId, res.nameToId, res.pendingConnections);
    }
    for (const p of res.pendingScopedVariables) {
      await insertVariables(this.sb, diagramId, [p.variable], null, res.nameToId, p.scopeElementName);
    }
    this.logActivity({
      diagramId,
      eventType: "tree.import",
      targetKind: "diagram",
      targetId: diagramId,
      payload: { elements: res.nameToId?.size ?? elements.length, parentPath: opts.parentPath ?? null },
    });
    return res;
  }


  /**
   * Merge (upsert by name) a list of children under `parentPath`. Existing
   * siblings not in the payload are left alone.
   */
  async mergeChildren(
    parentPath: string,
    children: ImportElement[],
    diagramId?: string,
  ) {
    const id = this.requireDiagramId(diagramId);
    const parent = await resolveElementByPath(this.sb, id, parentPath);
    return await mergeChildrenTree(this.sb, id, parent.id, children);
  }

  /**
   * Delete an element + its entire subtree (children, connections, source).
   * Resolves by slash path. The ONE canonical delete path — every surface
   * routes through here, so the "orphans children to top-level" bug can
   * never be reintroduced by a one-off `.delete().eq("id", x)` call.
   */
  async deleteElement(
    path: string,
    diagramId?: string,
  ): Promise<{ id: string; leafName: string; deletedIds: string[] }> {
    const id = this.requireDiagramId(diagramId);
    const r = await resolveElementByPath(this.sb, id, path);
    const res = await deleteElementSubtree(this.sb, id, r.id);
    this.logActivity({
      diagramId: id,
      eventType: "element.delete",
      targetKind: "element",
      targetId: r.id,
      targetLabel: r.leafName,
      payload: { deletedCount: res.deletedIds.length },
    });
    return { id: r.id, leafName: r.leafName, deletedIds: res.deletedIds };
  }

  /** Delete by id (when the caller already resolved the element). */
  async deleteElementById(
    rootElementId: string,
    diagramId?: string,
  ) {
    const id = this.requireDiagramId(diagramId);
    const res = await deleteElementSubtree(this.sb, id, rootElementId);
    this.logActivity({
      diagramId: id,
      eventType: "element.delete",
      targetKind: "element",
      targetId: rootElementId,
      payload: { deletedCount: res.deletedIds.length },
    });
    return res;
  }

  /**
   * Patch arbitrary scalar fields on an element WITHOUT touching its
   * children, source_code, connections, or variables. Useful for the
   * common "just rename / update description / move / recolor" case
   * where re-sending the full ImportElement payload to upsertElement
   * would clobber source_code and children.
   *
   * All keys are optional; pass only the columns you want to change.
   * `name` is validated to not contain "/" (path separator). Returns
   * the element id + the columns that were actually written.
   */
  async updateElementFields(
    path: string,
    fields: {
      name?: string;
      description?: string | null;
      background_color?: string | null;
      image_url?: string | null;
      show_image?: boolean;
      position_x?: number;
      position_y?: number;
      width?: number;
      height?: number;
      is_expanded?: boolean;
      sort_order?: number;
      is_project_root?: boolean;
      git_repo_url?: string | null;
      referenced_diagram_id?: string | null;
    },
    diagramId?: string,
  ): Promise<{ id: string; updated: Record<string, unknown> }> {
    const id = this.requireDiagramId(diagramId);
    const { id: elementId } = await resolveElementByPath(this.sb, id, path);
    const ALLOWED = [
      "name", "description", "background_color", "image_url", "show_image",
      "position_x", "position_y", "width", "height", "is_expanded",
      "sort_order", "is_project_root", "git_repo_url", "referenced_diagram_id",
    ] as const;
    const updates: Record<string, unknown> = {};
    for (const k of ALLOWED) {
      if (Object.prototype.hasOwnProperty.call(fields, k)) {
        updates[k] = (fields as Record<string, unknown>)[k];
      }
    }
    if (typeof updates.name === "string" && (updates.name as string).includes("/")) {
      throw new ValidationError(
        'Element name must not contain "/" (path separator). Use "-", "·", " — ", or " of " instead.',
      );
    }
    if (Object.keys(updates).length === 0) {
      return { id: elementId, updated: {} };
    }
    const { error } = await this.sb
      .from("diagram_elements")
      .update(updates)
      .eq("id", elementId);
    if (error) {
      throw new Error(`updateElementFields failed: ${error.message}`);
    }
    await this.sb
      .from("diagrams")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", id);
    const updatedKeys = Object.keys(updates);
    const isMoveOnly = updatedKeys.length > 0 &&
      updatedKeys.every((k) => k === "position_x" || k === "position_y");
    this.logActivity({
      diagramId: id,
      eventType: isMoveOnly ? "element.move" : "element.update",
      targetKind: "element",
      targetId: elementId,
      targetLabel: typeof updates.name === "string" ? (updates.name as string) : null,
      payload: { fields: updatedKeys },
    });
    return { id: elementId, updated: updates };
  }





  /** Add connections between siblings already in the diagram (by name). */
  async addConnections(
    parentPath: string | null,
    connections: ImportConnection[],
    diagramId?: string,
  ) {
    const id = this.requireDiagramId(diagramId);
    const parentId = await resolveParentByPath(this.sb, id, parentPath);
    let q = this.sb
      .from("diagram_elements")
      .select("id, name")
      .eq("diagram_id", id);
    q = parentId
      ? q.eq("parent_element_id", parentId)
      : q.is("parent_element_id", null);
    const { data: siblings } = await q;
    const nameToId = new Map<string, string>();
    for (const s of siblings ?? []) nameToId.set(s.name, s.id);
    await insertConnections(this.sb, id, nameToId, connections);
    if (connections.length > 0) {
      this.logActivity({
        diagramId: id,
        eventType: "connection.create",
        targetKind: "connection",
        payload: { count: connections.length },
      });
    }
  }


  /** Bulk upsert variables. Scope element resolved by `scope_element_name`. */
  async setVariables(
    variables: ImportVariable[],
    opts: { defaultScopePath?: string | null; diagramId?: string } = {},
  ) {
    const id = this.requireDiagramId(opts.diagramId);
    const defaultScopeId = await resolveParentByPath(
      this.sb,
      id,
      opts.defaultScopePath,
    );
    // Resolve name→id of every named sibling under defaultScopeId, so
    // variable.scope_element_name can match.
    const { data: rows } = await this.sb
      .from("diagram_elements")
      .select("id, name")
      .eq("diagram_id", id);
    const nameToId = new Map<string, string>();
    for (const r of rows ?? []) nameToId.set(r.name, r.id);
    await insertVariables(this.sb, id, variables, defaultScopeId, nameToId);
    if (variables.length > 0) {
      this.logActivity({
        diagramId: id,
        eventType: "variable.upsert",
        payload: { count: variables.length, names: variables.map((v) => v.name).slice(0, 20) },
      });
    }
  }

  /**
   * Replace (or attach) source_code on the element at `path`. Accepts plain
   * text or base64; auto-detected via ensureBase64.
   */
  async attachSource(
    path: string,
    content: string,
    opts: { filename?: string | null; diagramId?: string } = {},
  ): Promise<{ sourceCodeId: string }> {
    const id = this.requireDiagramId(opts.diagramId);
    const { id: elementId } = await resolveElementByPath(this.sb, id, path);
    const b64 = ensureBase64(content);
    // Default filename to the leaf path segment so source rows are never
    // anonymous. Callers can still pass `filename: null` explicitly via
    // an empty string if they really want no name.
    const leaf = path.split("/").filter(Boolean).pop() ?? null;
    const fname = opts.filename ?? leaf;
    // Use the SECURITY DEFINER RPC so this works under RLS for ordinary
    // authenticated users (e.g. tutorial run_script_async calling the
    // browser SDK). The RPC verifies the caller owns the diagram, inserts
    // the source row, and updates diagram_elements.source_code_id
    // atomically — direct INSERTs to element_source_code are blocked by
    // RLS for non-service-role callers.
    const { data: newId, error } = await this.sb.rpc(
      "insert_element_source_code",
      { _element_id: elementId, _source_code: b64, _file_name: fname },
    );
    if (error || !newId) {
      throw new Error(`attachSource insert failed: ${error?.message ?? "no id returned"}`);
    }
    this.logActivity({
      diagramId: id,
      eventType: "source_code.attach",
      targetKind: "element",
      targetId: elementId,
      targetLabel: fname ?? null,
      payload: { sourceCodeId: newId as string },
    });
    return { sourceCodeId: newId as string };
  }

  // ─── Tutorials & Archetypes ───────────────────────────────────
  /**
   * Insert a `custom_tutorials` row + its steps. Used by:
   *   • MCP create_archetype (is_archetype=true, is_visible=false default)
   *   • Frontend ImportTutorial.tsx (JSON paste import)
   *   • Future api-v1 REST endpoint
   *   • it.dc.createTutorial(...) inside tutorial-author scripts
   *
   * `createdBy` is the user id to stamp on the row. When the caller is
   * the browser anon client the underlying RLS already enforces this, but
   * we pass it explicitly so service-role callers (MCP) write the
   * correct attribution.
   *
   * Returns the new tutorial id and a list of inserted step indices.
   */
  async createTutorial(
    payload: {
      topicId?: string;
      label: string;
      description?: string;
      author?: string | null;
      iconName?: string;
      color?: string;
      categoryId?: string | null;
      diagramTitle?: string;
      tips?: string[];
      variableDefinitions?: unknown[];
      baseDiagram?: Record<string, unknown> | null;
      steps?: Array<TutorialStep | Record<string, unknown>>;
      isArchetype?: boolean;
      isVisible?: boolean;
      replayable?: boolean;
      /** Optional author assertion. `false` + heuristic-detected mutation
       *  → throws ValidationError (the safety claim doesn't hold and
       *  workspace viewers would be blocked from playing it). `true`
       *  is always accepted (authors may know about runtime side-effects
       *  the text-level scan can't see). Omitted → server decides. */
      hasMutationsHint?: boolean | null;
    },
    opts: { createdBy?: string | null } = {},
  ): Promise<{ id: string; stepCount: number; hasMutations: boolean }> {
    if (!payload.label?.trim()) throw new ValidationError("label is required");
    assertReplayableHasBase(payload.replayable ?? false, payload.baseDiagram);
    const topicId = payload.topicId ?? `arch-${crypto.randomUUID()}`;
    const steps = (payload.steps ?? []) as Array<Record<string, unknown>>;
    const detected = tutorialMutatesDiagram(steps);
    if (payload.hasMutationsHint === false && detected) {
      throw new ValidationError(
        "has_mutations was declared false, but the step list contains diagram-mutating operations " +
        "(mutationHeuristic.ts matched a completion_event in MUTATING_COMPLETION_EVENTS, " +
        "or a run_script that calls a non-whitelisted `it.dc.*` method — only getElement, " +
        "getSourceCode, getResolvedScope, and withDiagram are treated as read-only). Either " +
        "remove the mutating steps, set has_mutations: true, or omit the field and let the " +
        "server decide. Mutating archetypes cannot be played by workspace viewers (editor role required).",
      );
    }
    // Author may force `true` (conservative). Server-detected `true` always wins.
    const hasMutations = detected || payload.hasMutationsHint === true;
    const row: Record<string, unknown> = {
      topic_id: topicId,
      label: payload.label,
      description: payload.description ?? "",
      author: payload.author ?? null,
      icon_name: payload.iconName ?? "Sparkles",
      color: payload.color ?? "hsl(200, 70%, 55%)",
      category_id: payload.categoryId ?? null,
      diagram_title: payload.diagramTitle ?? "",
      tips: payload.tips ?? [],
      variable_definitions: payload.variableDefinitions ?? [],
      base_diagram: payload.baseDiagram ?? null,
      is_archetype: payload.isArchetype ?? false,
      is_visible: payload.isVisible ?? false,
      replayable: payload.replayable ?? false,
      has_mutations: hasMutations,
    };
    if (opts.createdBy) row.created_by = opts.createdBy;
    const { data: tut, error } = await this.sb
      .from("custom_tutorials")
      .insert(row)
      .select("id")
      .single();
    if (error || !tut) {
      throw new Error(`createTutorial insert failed: ${error?.message ?? "no id returned"}`);
    }
    const tutorialId = (tut as { id: string }).id;
    if (steps.length > 0) {
      const rows = stripClientKind(buildStepRows(tutorialId, steps));
      const { error: sErr } = await this.sb
        .from("custom_tutorial_steps")
        .insert(rows);
      if (sErr) throw new Error(`Steps insert failed: ${sErr.message}`);
    }
    return { id: tutorialId, stepCount: steps.length, hasMutations };
  }


  /**
   * Patch top-level fields on a tutorial/archetype. Accepts camelCase;
   * undefined keys are dropped (no clobbering with null).
   */
  async updateTutorial(
    id: string,
    patch: {
      label?: string;
      description?: string;
      author?: string | null;
      iconName?: string;
      color?: string;
      categoryId?: string | null;
      diagramTitle?: string;
      tips?: string[];
      variableDefinitions?: unknown[];
      baseDiagram?: Record<string, unknown> | null;
      isArchetype?: boolean;
      isVisible?: boolean;
      replayable?: boolean;
    },
  ): Promise<{ id: string; updated: string[] }> {
    const map: Record<string, string> = {
      label: "label",
      description: "description",
      author: "author",
      iconName: "icon_name",
      color: "color",
      categoryId: "category_id",
      diagramTitle: "diagram_title",
      tips: "tips",
      variableDefinitions: "variable_definitions",
      baseDiagram: "base_diagram",
      isArchetype: "is_archetype",
      isVisible: "is_visible",
      replayable: "replayable",
    };
    const cleaned: Record<string, unknown> = {};
    for (const [k, dbKey] of Object.entries(map)) {
      const v = (patch as Record<string, unknown>)[k];
      if (v !== undefined) cleaned[dbKey] = v;
    }
    if (Object.keys(cleaned).length === 0) return { id, updated: [] };
    // If this patch could leave the archetype in (replayable=true, base_diagram=empty),
    // re-validate against current row state before writing.
    if (patch.replayable === true || patch.baseDiagram !== undefined) {
      const { data: current } = await this.sb
        .from("custom_tutorials")
        .select("replayable, base_diagram")
        .eq("id", id)
        .maybeSingle();
      const nextReplayable = patch.replayable ?? current?.replayable ?? false;
      const nextBase = patch.baseDiagram !== undefined ? patch.baseDiagram : current?.base_diagram;
      assertReplayableHasBase(nextReplayable, nextBase);
    }
    const { error } = await this.sb
      .from("custom_tutorials")
      .update(cleaned)
      .eq("id", id);
    if (error) throw new Error(error.message);
    return { id, updated: Object.keys(cleaned) };
  }

  /**
   * Replace all steps for a tutorial atomically (delete-then-insert).
   * Used by MCP update_archetype_steps and any future step editor UI.
   * Recomputes `has_mutations` from the new step list and persists it
   * — see mutationHeuristic.ts. The stored value is what gates the
   * Replayable Archetypes play button for non-editor viewers.
   */
  async replaceTutorialSteps(
    id: string,
    steps: Array<TutorialStep | Record<string, unknown>>,
  ): Promise<{ id: string; stepCount: number; hasMutations: boolean }> {
    await this.sb.from("custom_tutorial_steps").delete().eq("tutorial_id", id);
    const stepArr = steps as Array<Record<string, unknown>>;
    const hasMutations = tutorialMutatesDiagram(stepArr);
    if (stepArr.length > 0) {
      const rows = stripClientKind(buildStepRows(id, stepArr));
      const { error } = await this.sb
        .from("custom_tutorial_steps")
        .insert(rows);
      if (error) throw new Error(error.message);
    }
    // Persist the computed hint so the play-button query doesn't need to
    // re-walk steps on every diagram open.
    await this.sb
      .from("custom_tutorials")
      .update({ has_mutations: hasMutations })
      .eq("id", id);
    return { id, stepCount: stepArr.length, hasMutations };
  }

  /**
   * Scaffold an archetype's base_diagram subtree onto a diagram and
   * spawn a `tutorial_sessions` row. Mirrors the `add_archetype_to_diagram`
   * MCP tool and the `add_archetype` tutorial step. Resolves the
   * archetype by uuid OR by topic_id (instance lane). Requires `userId`
   * — pass it through, or omit to look it up via `sb.auth.getUser()`
   * (works for browser anon clients; service-role callers MUST pass it).
   */
  async addArchetype(opts: {
    archetypeId?: string;
    archetypeTopicId?: string;
    diagramId?: string;
    parentElementId?: string | null;
    variableValues?: Record<string, unknown>;
    lane?: ConstructLane;
    userId?: string;
  }): Promise<AddArchetypeCoreResult> {
    const diagramId = this.requireDiagramId(opts.diagramId);
    let archetypeId = opts.archetypeId ?? null;
    if (!archetypeId && opts.archetypeTopicId) {
      const { data } = await this.sb
        .from("custom_tutorials")
        .select("id")
        .eq("topic_id", opts.archetypeTopicId)
        .eq("is_archetype", true)
        .maybeSingle();
      archetypeId = (data as { id?: string } | null)?.id ?? null;
    }
    if (!archetypeId) {
      throw new ValidationError(
        "addArchetype requires archetypeId or archetypeTopicId (resolved via custom_tutorials.topic_id).",
      );
    }
    let userId = opts.userId ?? null;
    if (!userId) {
      const { data: u } = await this.sb.auth.getUser();
      userId = u.user?.id ?? null;
    }
    if (!userId) {
      throw new ValidationError("addArchetype requires userId (no authenticated session).");
    }
    return await addArchetypeCore({
      sb: this.sb,
      diagramId,
      parentElementId: opts.parentElementId ?? null,
      archetypeId,
      userId,
      variableValues: opts.variableValues,
      lane: opts.lane ?? "instance",
    });
  }
}


function decodeUtf8Base64(b64: string): string {
  // atob is universal (browser + Deno). decodeURIComponent/escape pair
  // gives us proper UTF-8.
  try {
    return decodeURIComponent(escape(atob(b64)));
  } catch {
    return atob(b64);
  }
}
