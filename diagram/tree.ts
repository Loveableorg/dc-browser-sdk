// Shared diagram-core mutations: recursive tree insert + merge + delete,
// path resolution, connection and variable insertion.
//
// This file is the SINGLE canonical implementation of the import/insert/
// merge/delete behavior. The UI (`src/lib/diagramImportUtils.ts`,
// `src/pages/DiagramEditor.tsx`) is treated as the BASELINE — every
// semantic difference between this module and the UI is a bug. The
// alignment lives here and is mirrored back to the UI in a later cut.
//
// Hard rules (see _shared/lib/README.md):
//   - Transport-agnostic: every function takes a SupabaseClient.
//   - Pure TS, no Deno.*/DOM/Node globals, universal APIs only.
//   - Always import with explicit .ts extensions.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.49.1";
import type {
  ImportConnection,
  ImportElement,
  ImportVariable,
} from "../domain/types.ts";
import { ensureBase64 } from "../encoding/base64.ts";
import { NotFoundError, ValidationError } from "../errors/index.ts";
import { deriveEffectiveDefault } from "./variableDefaults.ts";

// ─── Path resolution ─────────────────────────────────────────────
export interface ResolvedElement {
  id: string;
  parentId: string | null;
  leafName: string;
}

export async function resolveElementByPath(
  sb: SupabaseClient,
  diagramId: string,
  pathStr: string,
): Promise<ResolvedElement> {
  const segments = pathStr.split("/").filter(Boolean);
  if (!segments.length) {
    throw new ValidationError("path must have at least one segment");
  }
  let parentId: string | null = null;
  let lastId: string | null = null;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    let q = sb.from("diagram_elements")
      .select("id")
      .eq("diagram_id", diagramId)
      .eq("name", seg);
    q = parentId
      ? q.eq("parent_element_id", parentId)
      : q.is("parent_element_id", null);
    const { data } = await q.maybeSingle();
    if (!data) {
      throw new NotFoundError(`Path segment "${seg}" not found`, {
        path: pathStr,
        segment: seg,
      });
    }
    lastId = data.id;
    if (i < segments.length - 1) parentId = data.id;
  }
  return { id: lastId!, parentId, leafName: segments[segments.length - 1] };
}

export async function resolveParentByPath(
  sb: SupabaseClient,
  diagramId: string,
  pathStr: string | null | undefined,
): Promise<string | null> {
  if (!pathStr) return null;
  const r = await resolveElementByPath(sb, diagramId, pathStr);
  return r.id;
}

// ─── base_diagram shape normalization ────────────────────────────
export function normalizeBaseDiagram(
  raw: unknown,
): { elements: ImportElement[]; connections: ImportConnection[] } {
  if (!raw || typeof raw !== "object") return { elements: [], connections: [] };
  if (Array.isArray(raw)) {
    return { elements: raw as ImportElement[], connections: [] };
  }
  const obj = raw as Record<string, unknown>;
  const connections = Array.isArray(obj.connections)
    ? (obj.connections as ImportConnection[])
    : [];
  if (Array.isArray(obj.elements)) {
    return { elements: obj.elements as ImportElement[], connections };
  }
  if (obj.root && typeof obj.root === "object") {
    return { elements: [obj.root as ImportElement], connections };
  }
  if (obj.element && typeof obj.element === "object") {
    return { elements: [obj.element as ImportElement], connections };
  }
  if (typeof obj.name === "string") {
    return { elements: [obj as unknown as ImportElement], connections: [] };
  }
  return { elements: [], connections: [] };
}

// ─── Variable default helpers (UI parity) ────────────────────────
function synthesizeDefinition(
  name: string,
): { name: string; type: "string"; label: string } {
  return { name, type: "string", label: name };
}

/**
 * Pick the initial value for a variable: explicit non-null `value` wins,
 * then `definition.defaultValue` (recursively, including per-field defaults
 * for object types), then null.
 *
 * Explicit `null` is treated as "no value" so round-tripped exports — which
 * always emit `value: <current>` and may emit `null` for never-touched vars
 * — still pick up the declared defaults. There's no way to express
 * "intentionally null distinct from default" in this format, and the
 * ambiguity has bitten import → render flows in the past.
 */
function pickInitialValue(v: ImportVariable): unknown {
  if (
    Object.prototype.hasOwnProperty.call(v, "value") &&
    v.value !== undefined &&
    v.value !== null
  ) {
    return v.value;
  }
  const derived = deriveEffectiveDefault(v.definition as never);
  return derived === undefined ? null : derived;
}

// ─── Tree insert ─────────────────────────────────────────────────
export interface PendingGitFetch {
  elementId: string;
  gitRepoUrl: string;
  gitBranch?: string;
  gitProvider?: "github" | "gitlab" | "bitbucket" | "generic";
}

interface PendingScopedVariable {
  scopeElementName: string;
  variable: ImportVariable;
}

export interface InsertTreeResult {
  nameToId: Map<string, string>;
  rootIds: string[];
  insertedElementIds: string[];
  insertedSourceCodeIds: string[];
  pendingConnections: ImportConnection[];
  pendingGitFetches: PendingGitFetch[];
  pendingScopedVariables: PendingScopedVariable[];
}

export interface InsertTreeOptions {
  /** How many siblings already exist at this level (for auto-layout offset). */
  existingChildCount?: number;
  /** Fixed column count for grid layout. */
  cols?: number;
  hGap?: number;
  vGap?: number;
  /** Fallback background color when the element specifies none. */
  defaultColor?: string | null;
}

/**
 * Recursively insert a tree of ImportElement rows. Mirrors the UI's
 * `insertElementTree` semantics from `src/lib/diagramImportUtils.ts`:
 *   - source code is written via the `insert_element_source_code` RPC so
 *     ownership is checked server-side (NOT raw insert).
 *   - per-element scoped variables are DEFERRED so scope name resolution
 *     sees the full tree; caller flushes them via `insertVariables` once
 *     the recursion completes.
 *   - `auto_fetch_on_import` git fetches are accumulated for the caller.
 *   - auto-layout grid offset uses `existingChildCount` so additive
 *     imports don't stack on top of existing children.
 */
export async function insertElementTree(
  sb: SupabaseClient,
  diagramId: string,
  parentId: string | null,
  elements: ImportElement[],
  opts: InsertTreeOptions = {},
  // Recursion accumulators — leave defaults at the root call.
  nameToId: Map<string, string> = new Map(),
  pendingConnections: ImportConnection[] = [],
  insertedElementIds: string[] = [],
  insertedSourceCodeIds: string[] = [],
  pendingGitFetches: PendingGitFetch[] = [],
  pendingScopedVariables: PendingScopedVariable[] = [],
  rootIds: string[] = [],
): Promise<InsertTreeResult> {
  const {
    existingChildCount = 0,
    hGap = 240,
    vGap = 200,
    defaultColor = null,
  } = opts;
  const cols = opts.cols ??
    Math.max(1, Math.ceil(Math.sqrt(existingChildCount + elements.length)));

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el.name.includes("/")) {
      throw new ValidationError(
        `Element name "${el.name}" contains "/" — that character is reserved as the path separator. Rename before inserting.`,
        { name: el.name },
      );
    }
    const idx = existingChildCount + i;
    const posX = el.position_x ?? 40 + (idx % cols) * hGap;
    const posY = el.position_y ?? 40 + Math.floor(idx / cols) * vGap;

    const { data: inserted, error } = await sb
      .from("diagram_elements")
      .insert({
        diagram_id: diagramId,
        parent_element_id: parentId,
        name: el.name,
        description: el.description ?? null,
        background_color: el.background_color ?? defaultColor,
        image_url: el.image_url ?? null,
        show_image: el.show_image ?? false,
        position_x: posX,
        position_y: posY,
        width: el.width ?? 220,
        height: el.height ?? 180,
        is_expanded: el.is_expanded ?? true,
        sort_order: el.sort_order ?? 0,
        is_project_root: el.is_project_root ?? false,
        git_repo_url: el.git_repo_url ?? null,
        referenced_diagram_id: el.referenced_diagram_id ?? null,
      })
      .select("id")
      .single();
    if (error || !inserted) {
      throw new Error(`Insert "${el.name}": ${error?.message}`);
    }
    const elementId = inserted.id as string;
    nameToId.set(el.name, elementId);
    insertedElementIds.push(elementId);
    rootIds.push(elementId);

    // Source code via ownership-checked RPC (matches UI behavior).
    if (el.source_code) {
      const { data: newScId, error: srcErr } = await sb.rpc(
        "insert_element_source_code",
        {
          _element_id: elementId,
          _source_code: ensureBase64(el.source_code),
          _file_name: el.file_name ?? null,
        },
      );
      if (srcErr) {
        throw new Error(srcErr.message ?? "Failed to insert source code");
      }
      if (newScId) insertedSourceCodeIds.push(newScId as string);
    }

    if (
      el.git_repo_url && el.is_project_root && el.auto_fetch_on_import !== false
    ) {
      pendingGitFetches.push({
        elementId,
        gitRepoUrl: el.git_repo_url,
        gitBranch: el.git_branch,
        gitProvider: el.git_provider,
      });
    }

    // Defer per-element scoped variables until the whole tree is in so
    // `scopeElementName` references can resolve via `nameToId`.
    if (Array.isArray(el.variables) && el.variables.length) {
      for (const v of el.variables as ImportVariable[]) {
        pendingScopedVariables.push({
          scopeElementName: el.name,
          variable: v,
        });
      }
    }

    // Connection collection happens AFTER recursion in the UI, but since
    // we only collect (not insert), order is irrelevant — keep close to
    // the element so authors reason about it locally.
    if (el.connections?.length) {
      pendingConnections.push(...el.connections);
    }

    if (el.children?.length) {
      await insertElementTree(
        sb,
        diagramId,
        elementId,
        el.children,
        { hGap, vGap, defaultColor },
        nameToId,
        pendingConnections,
        insertedElementIds,
        insertedSourceCodeIds,
        pendingGitFetches,
        pendingScopedVariables,
        [], // child rootIds is unused at outer level
      );
    }
  }
  return {
    nameToId,
    rootIds,
    insertedElementIds,
    insertedSourceCodeIds,
    pendingConnections,
    pendingGitFetches,
    pendingScopedVariables,
  };
}

// ─── Child merge (single-level patch) ────────────────────────────
/**
 * Lightweight in-place patch of immediate children by name. Used by
 * upsert_element's "merge" mode for callers that don't want full recursive
 * import semantics. For UI-parity recursive merge (with source code
 * replacement + wrapper-unwrap), use `mergeImportTree`.
 */
export async function mergeChildrenTree(
  sb: SupabaseClient,
  diagramId: string,
  parentId: string,
  children: ImportElement[],
): Promise<{ nameToId: Map<string, string> }> {
  const nameToId = new Map<string, string>();
  const { data: existingRows } = await sb
    .from("diagram_elements")
    .select("id, name")
    .eq("diagram_id", diagramId)
    .eq("parent_element_id", parentId);
  const existingByName = new Map<string, string>();
  for (const r of existingRows ?? []) existingByName.set(r.name, r.id);

  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    const existingId = existingByName.get(el.name);
    if (existingId) {
      const updates: Record<string, unknown> = { name: el.name };
      if (el.description !== undefined) updates.description = el.description;
      if (el.background_color !== undefined) {
        updates.background_color = el.background_color;
      }
      if (el.image_url !== undefined) updates.image_url = el.image_url;
      if (el.show_image !== undefined) updates.show_image = el.show_image;
      if (el.position_x !== undefined) updates.position_x = el.position_x;
      if (el.position_y !== undefined) updates.position_y = el.position_y;
      if (el.width !== undefined) updates.width = el.width;
      if (el.height !== undefined) updates.height = el.height;
      if (el.is_expanded !== undefined) updates.is_expanded = el.is_expanded;
      if (el.sort_order !== undefined) updates.sort_order = el.sort_order;
      if (el.is_project_root !== undefined) {
        updates.is_project_root = el.is_project_root;
      }
      if (el.git_repo_url !== undefined) updates.git_repo_url = el.git_repo_url;
      if (el.referenced_diagram_id !== undefined) {
        updates.referenced_diagram_id = el.referenced_diagram_id;
      }
      await sb.from("diagram_elements").update(updates).eq("id", existingId);
      nameToId.set(el.name, existingId);

      if (el.children?.length) {
        const sub = await mergeChildrenTree(
          sb,
          diagramId,
          existingId,
          el.children,
        );
        sub.nameToId.forEach((v, k) => nameToId.set(k, v));
        if (el.connections?.length) {
          await insertConnections(sb, diagramId, sub.nameToId, el.connections);
        }
      }
    } else {
      const sub = await insertElementTree(sb, diagramId, parentId, [el]);
      sub.nameToId.forEach((v, k) => nameToId.set(k, v));
    }
  }
  return { nameToId };
}

// ─── Full-tree merge (UI parity: mergeElementWithTree) ───────────
/**
 * Recursive merge of an import payload INTO an existing target element.
 * Mirrors `DiagramEditor.mergeElementWithTree` exactly:
 *
 *   - Each top-level element in `payload.elements` is matched by name
 *     against `targetId`'s existing children.
 *       • Match → patch leaf attributes in place + recurse.
 *         Source code, when provided, replaces the linked source row.
 *       • No match → insert the subtree as a brand-new child.
 *   - Wrapper-unwrap: a single root whose name EXACTLY matches the target
 *     element name is treated as a no-op wrapper; its children merge
 *     directly into the target. Any other single-root payload is preserved
 *     (the root becomes a new/updated child of the target).
 *   - All other existing children at every level are left untouched.
 *   - Top-level connections + variables are inserted additively.
 *
 * Returns the merge stats plus all pending git fetches and source code
 * ids the caller may need for rollback / post-import actions.
 */
export interface MergeResult {
  updatedCount: number;
  insertedCount: number;
  insertedElementIds: string[];
  insertedSourceCodeIds: string[];
  pendingGitFetches: PendingGitFetch[];
  nameToId: Map<string, string>;
}

export async function mergeImportTree(
  sb: SupabaseClient,
  diagramId: string,
  targetId: string,
  payload: {
    elements: ImportElement[];
    connections?: ImportConnection[];
    variables?: ImportVariable[];
  },
): Promise<MergeResult> {
  // Resolve target name + initial live snapshot.
  const { data: target } = await sb
    .from("diagram_elements")
    .select("id, name")
    .eq("id", targetId)
    .maybeSingle();
  if (!target) throw new NotFoundError("Target element not found");

  // Wrapper-unwrap: name-aware (matches UI).
  let importedChildren: ImportElement[];
  const onlyRoot = payload.elements.length === 1 ? payload.elements[0] : null;
  const rootMatchesTarget = !!onlyRoot &&
    typeof onlyRoot.name === "string" && onlyRoot.name === target.name;
  if (rootMatchesTarget && onlyRoot?.children?.length) {
    importedChildren = onlyRoot.children!;
  } else {
    importedChildren = payload.elements;
  }
  if (!importedChildren.length) {
    throw new ValidationError(
      "Nothing to merge — payload has no elements to add.",
    );
  }

  // Snapshot full element tree once; mutate as inserts land.
  const { data: liveAll } = await sb
    .from("diagram_elements")
    .select("id, name, parent_element_id, source_code_id")
    .eq("diagram_id", diagramId);
  type Live = {
    id: string;
    name: string;
    parent_element_id: string | null;
    source_code_id: string | null;
  };
  const liveByParent = new Map<string | null, Live[]>();
  for (const e of (liveAll ?? []) as Live[]) {
    const arr = liveByParent.get(e.parent_element_id) ?? [];
    arr.push(e);
    liveByParent.set(e.parent_element_id, arr);
  }

  const result: MergeResult = {
    updatedCount: 0,
    insertedCount: 0,
    insertedElementIds: [],
    insertedSourceCodeIds: [],
    pendingGitFetches: [],
    nameToId: new Map(),
  };

  const mergeInto = async (
    parentDbId: string,
    incoming: ImportElement[],
  ): Promise<void> => {
    const existingChildren = liveByParent.get(parentDbId) ?? [];
    const existingByName = new Map(existingChildren.map((e) => [e.name, e]));

    for (const el of incoming) {
      const existing = existingByName.get(el.name);
      if (existing) {
        const updates: Record<string, unknown> = {};
        if (el.description !== undefined) updates.description = el.description;
        if (el.background_color !== undefined) {
          updates.background_color = el.background_color;
        }
        if (el.image_url !== undefined) updates.image_url = el.image_url;
        if (el.show_image !== undefined) updates.show_image = el.show_image;
        if (el.is_expanded !== undefined) updates.is_expanded = el.is_expanded;
        if (el.width !== undefined) updates.width = el.width;
        if (el.height !== undefined) updates.height = el.height;
        if (el.is_project_root !== undefined) {
          updates.is_project_root = el.is_project_root;
        }
        if (el.git_repo_url !== undefined) {
          updates.git_repo_url = el.git_repo_url;
        }
        if (Object.keys(updates).length) {
          await sb.from("diagram_elements").update(updates).eq(
            "id",
            existing.id,
          );
        }
        result.updatedCount++;
        result.nameToId.set(el.name, existing.id);

        if (el.source_code !== undefined && el.source_code !== null) {
          const encoded = ensureBase64(el.source_code);
          if (existing.source_code_id) {
            await sb
              .from("element_source_code")
              .update({
                source_code: encoded,
                file_name: el.file_name ?? null,
              })
              .eq("id", existing.source_code_id);
          } else {
            const { data: newScId } = await sb.rpc(
              "insert_element_source_code",
              {
                _element_id: existing.id,
                _source_code: encoded,
                _file_name: el.file_name ?? null,
              },
            );
            if (newScId) result.insertedSourceCodeIds.push(newScId as string);
          }
        }

        if (el.children?.length) {
          await mergeInto(existing.id, el.children);
        }
      } else {
        const baseCount = (liveByParent.get(parentDbId) ?? []).length;
        const sub = await insertElementTree(
          sb,
          diagramId,
          parentDbId,
          [el],
          { existingChildCount: baseCount },
        );
        result.insertedCount++;
        result.insertedElementIds.push(...sub.insertedElementIds);
        result.insertedSourceCodeIds.push(...sub.insertedSourceCodeIds);
        result.pendingGitFetches.push(...sub.pendingGitFetches);
        sub.nameToId.forEach((v, k) => result.nameToId.set(k, v));
        if (sub.pendingConnections.length) {
          await insertConnections(
            sb,
            diagramId,
            sub.nameToId,
            sub.pendingConnections,
          );
        }
        for (const p of sub.pendingScopedVariables) {
          await insertVariables(
            sb,
            diagramId,
            [p.variable],
            null,
            sub.nameToId,
            p.scopeElementName,
          );
        }
        // Patch live snapshot so subsequent same-level merges see it.
        const newId = sub.nameToId.get(el.name);
        if (newId) {
          const arr = liveByParent.get(parentDbId) ?? [];
          arr.push({
            id: newId,
            name: el.name,
            parent_element_id: parentDbId,
            source_code_id: null,
          });
          liveByParent.set(parentDbId, arr);
        }
      }
    }
  };

  await mergeInto(targetId, importedChildren);

  // Top-level connections: wire against the full live element set after
  // merge (recursive by name; matches UI semantics).
  if (payload.connections?.length) {
    const { data: liveAfter } = await sb
      .from("diagram_elements")
      .select("id, name")
      .eq("diagram_id", diagramId);
    const nameMap = new Map<string, string>(
      (liveAfter ?? []).map((r) => [r.name as string, r.id as string]),
    );
    await insertConnections(sb, diagramId, nameMap, payload.connections);
  }

  if (payload.variables?.length) {
    await insertVariables(
      sb,
      diagramId,
      payload.variables,
      null,
      result.nameToId,
    );
  }

  return result;
}

// ─── Connection insert ───────────────────────────────────────────
export async function insertConnections(
  sb: SupabaseClient,
  diagramId: string,
  nameToId: Map<string, string>,
  connections: ImportConnection[],
): Promise<void> {
  for (const c of connections) {
    const s = nameToId.get(c.start_element_name);
    const e = nameToId.get(c.end_element_name);
    if (!s || !e) continue;
    await sb.from("element_connections").insert({
      diagram_id: diagramId,
      start_element_id: s,
      end_element_id: e,
      start_shape: c.start_shape ?? "none",
      end_shape: c.end_shape ?? "none",
      line_color: c.line_color ?? "#6b7280",
      start_label: c.start_label ?? null,
      middle_label: c.middle_label ?? null,
      end_label: c.end_label ?? null,
    });
  }
}

// ─── Variable insert (UI parity: pickInitialValue + synthesizeDefinition) ─
export async function insertVariables(
  sb: SupabaseClient,
  diagramId: string,
  variables: ImportVariable[],
  defaultScopeId: string | null,
  nameToId?: Map<string, string>,
  forcedScopeName?: string,
): Promise<void> {
  for (let i = 0; i < variables.length; i++) {
    const v = variables[i];
    if (!v?.name) continue;

    const scopeName = forcedScopeName ?? v.scope_element_name;
    let scopeId: string | null = defaultScopeId;
    if (scopeName && nameToId?.get(scopeName)) {
      scopeId = nameToId.get(scopeName)!;
    }

    const definition = (v.definition as { name?: string } | undefined) ??
      synthesizeDefinition(v.name);
    // Defensive: keep definition.name aligned with row name (template lookup).
    if (definition.name !== v.name) {
      (definition as { name: string }).name = v.name;
    }

    await sb.from("diagram_variables").insert({
      diagram_id: diagramId,
      name: v.name,
      definition,
      value: pickInitialValue(v),
      scope_element_id: scopeId,
      sort_order: v.sort_order ?? i,
    });
  }
}

// ─── Subtree delete ──────────────────────────────────────────────
export interface DeleteSubtreeResult {
  deletedIds: string[];
  deletedConnectionCount: number;
  deletedSourceCodeIds: string[];
}

/**
 * Delete an element and its entire subtree (children, grandchildren, …),
 * plus connections touching the subtree and orphaned source_code rows.
 *
 * The DB does NOT have ON DELETE CASCADE on
 * `diagram_elements.parent_element_id`, so a naive
 * `delete().eq("id", rootId)` either fails or — historically — orphans
 * children up to the top level. This is the ONE canonical impl; every
 * surface (front-end, MCP tools, REST) routes through here so the bug
 * cannot regress in just one spot.
 */
export async function deleteElementSubtree(
  sb: SupabaseClient,
  diagramId: string,
  rootElementId: string,
): Promise<DeleteSubtreeResult> {
  const subtreeIds: string[] = [rootElementId];
  let frontier: string[] = [rootElementId];
  while (frontier.length) {
    const { data: kids, error } = await sb
      .from("diagram_elements")
      .select("id")
      .eq("diagram_id", diagramId)
      .in("parent_element_id", frontier);
    if (error) throw error;
    const ids = (kids ?? []).map((r) => r.id as string);
    if (!ids.length) break;
    subtreeIds.push(...ids);
    frontier = ids;
  }

  const { data: scRows } = await sb
    .from("diagram_elements")
    .select("source_code_id")
    .in("id", subtreeIds)
    .not("source_code_id", "is", null);
  const sourceCodeIds = (scRows ?? [])
    .map((r) => r.source_code_id as string | null)
    .filter((v): v is string => !!v);

  const csv = subtreeIds.join(",");
  const { count: connCount } = await sb
    .from("element_connections")
    .delete({ count: "exact" })
    .or(`start_element_id.in.(${csv}),end_element_id.in.(${csv})`);

  const reversed = [...subtreeIds].reverse();
  const { error: delErr } = await sb
    .from("diagram_elements")
    .delete()
    .in("id", reversed);
  if (delErr) throw delErr;

  if (sourceCodeIds.length) {
    await sb.from("element_source_code").delete().in("id", sourceCodeIds);
  }

  return {
    deletedIds: subtreeIds,
    deletedConnectionCount: connCount ?? 0,
    deletedSourceCodeIds: sourceCodeIds,
  };
}
