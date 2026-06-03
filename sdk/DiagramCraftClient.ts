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
  resolveElementByPath,
  resolveParentByPath,
} from "../diagram/tree.ts";
import { ensureBase64 } from "../encoding/base64.ts";
import { NotFoundError, ValidationError } from "../errors/index.ts";
import { buildStepRows } from "../tutorial/stepInput.ts";

export interface DiagramCraftClientOptions {
  /** Optional default diagram id; methods accept an override per call. */
  diagramId?: string;
}

/**
 * Stateful SDK bound to a Supabase client (and optionally a default diagram).
 * Mirrors the MCP tool surface but throws typed `DomainError`s on failure.
 */
export class DiagramCraftClient {
  constructor(
    private readonly sb: SupabaseClient,
    private readonly opts: DiagramCraftClientOptions = {},
  ) {}

  /** Return a new client bound to a specific diagram id. */
  withDiagram(diagramId: string): DiagramCraftClient {
    return new DiagramCraftClient(this.sb, { ...this.opts, diagramId });
  }

  private requireDiagramId(diagramId?: string): string {
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
    return await insertElementTree(this.sb, diagramId, parentId, elements);
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
    return { id: r.id, leafName: r.leafName, deletedIds: res.deletedIds };
  }

  /** Delete by id (when the caller already resolved the element). */
  async deleteElementById(
    rootElementId: string,
    diagramId?: string,
  ) {
    const id = this.requireDiagramId(diagramId);
    return await deleteElementSubtree(this.sb, id, rootElementId);
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
    },
    opts: { createdBy?: string | null } = {},
  ): Promise<{ id: string; stepCount: number }> {
    if (!payload.label?.trim()) throw new ValidationError("label is required");
    const topicId = payload.topicId ?? `arch-${crypto.randomUUID()}`;
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
    const steps = (payload.steps ?? []) as Array<Record<string, unknown>>;
    if (steps.length > 0) {
      const rows = buildStepRows(tutorialId, steps);
      const { error: sErr } = await this.sb
        .from("custom_tutorial_steps")
        .insert(rows);
      if (sErr) throw new Error(`Steps insert failed: ${sErr.message}`);
    }
    return { id: tutorialId, stepCount: steps.length };
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
    };
    const cleaned: Record<string, unknown> = {};
    for (const [k, dbKey] of Object.entries(map)) {
      const v = (patch as Record<string, unknown>)[k];
      if (v !== undefined) cleaned[dbKey] = v;
    }
    if (Object.keys(cleaned).length === 0) return { id, updated: [] };
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
   */
  async replaceTutorialSteps(
    id: string,
    steps: Array<TutorialStep | Record<string, unknown>>,
  ): Promise<{ id: string; stepCount: number }> {
    await this.sb.from("custom_tutorial_steps").delete().eq("tutorial_id", id);
    const stepArr = steps as Array<Record<string, unknown>>;
    if (stepArr.length > 0) {
      const rows = buildStepRows(id, stepArr);
      const { error } = await this.sb
        .from("custom_tutorial_steps")
        .insert(rows);
      if (error) throw new Error(error.message);
    }
    return { id, stepCount: stepArr.length };
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
