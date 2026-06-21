// SpaceCraftClient — workspace-level superset of DiagramCraftClient.
//
// Bound to a workspace (and optionally a "current" diagram). Inherits
// every diagram-scoped method from DiagramCraftClient so workspace
// constructs can drop into any diagram in the workspace without
// re-instantiating a client. Adds workspace-level reads (list diagrams,
// list members, fetch workspace variables, get_workspace_structure) and
// workspace-level mutations (create diagram, upsert workspace variables,
// import an ImportWorkspace tree).
//
// Caller-supplied SupabaseClient determines effective privileges (same
// rule as DiagramCraftClient). Permission to operate on a workspace is
// enforced by RLS on the underlying tables — this SDK does not check
// roles client-side.
//
// Mirrors the MCP "workspace_*" tool surface and is what tutorial scripts
// for workspace constructs receive as `it.sc`. See mutationHeuristic.ts
// (`SC_SDK_READONLY_METHODS`) for the read-only allow-list — keep it in
// sync with the methods marked READ-ONLY below.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.49.1";
import { DiagramCraftClient, type DiagramCraftClientOptions } from "./DiagramCraftClient.ts";
import { ValidationError, NotFoundError } from "../errors/index.ts";
import type {
  ImportDiagram,
  ImportWorkspace,
  ImportDiagramElement,
} from "../domain/constructImport.ts";
import type { ImportVariable } from "../domain/types.ts";
import { insertElementTree, insertConnections, insertVariables, resolveParentByPath } from "../diagram/tree.ts";

export interface SpaceCraftClientOptions extends DiagramCraftClientOptions {
  /** Required for workspace-level operations; diagram-level methods still
   *  work without it as long as `diagramId` is set. */
  workspaceId?: string;
}

export interface WorkspaceDiagramSummary {
  id: string;
  title: string;
  description: string | null;
  updated_at: string;
  user_id: string;
}

export interface WorkspaceMemberSummary {
  user_id: string;
  role: string;
}

/** Lightweight structural snapshot returned by `getWorkspaceStructure` —
 *  intentionally shaped like the `WorkspaceTreeNode` browser type so the
 *  same picker components can render it. Folders are reserved for when
 *  the backend gains folder support; today the array is always empty. */
export interface WorkspaceStructureNode {
  id: string;
  name: string;
  description: string | null;
  diagrams: WorkspaceDiagramSummary[];
  /** Reserved — folders not yet modelled. */
  folders: never[];
  /** Reserved — nested workspaces not yet modelled. */
  workspaces: never[];
}

export class SpaceCraftClient extends DiagramCraftClient {
  constructor(
    sb: SupabaseClient,
    private readonly spaceOpts: SpaceCraftClientOptions = {},
  ) {
    super(sb, spaceOpts);
  }

  private requireWorkspaceId(workspaceId?: string): string {
    const id = workspaceId ?? this.spaceOpts.workspaceId;
    if (!id) {
      throw new ValidationError(
        "workspaceId is required (pass to method or construct with workspaceId)",
      );
    }
    return id;
  }

  /** Re-bind this client to a different diagram while preserving the
   *  workspace binding. Overrides DiagramCraftClient.withDiagram. */
  override withDiagram(diagramId: string): SpaceCraftClient {
    return new SpaceCraftClient(this.sb, {
      ...this.spaceOpts,
      diagramId,
    });
  }

  /** Re-bind this client to a different workspace. */
  withWorkspace(workspaceId: string): SpaceCraftClient {
    return new SpaceCraftClient(this.sb, {
      ...this.spaceOpts,
      workspaceId,
    });
  }

  /** Return a plain DiagramCraftClient bound to `diagramId` (drops the
   *  workspace binding). Use this when a workspace-construct script wants
   *  to hand a strictly diagram-scoped client to a helper that expects
   *  `it.dc`, without leaking workspace-level methods. */
  dcFor(diagramId: string): DiagramCraftClient {
    return new DiagramCraftClient(this.sb, {
      ...this.spaceOpts,
      diagramId,
    });
  }

  /** Plain DiagramCraftClient bound to the SpaceCraftClient's current
   *  `diagramId` (if any). Throws if no diagram is currently bound — use
   *  `dcFor(id)` to bind one explicitly. */
  get dc(): DiagramCraftClient {
    if (!this.spaceOpts.diagramId) {
      throw new ValidationError(
        "No diagram currently bound — call sc.dcFor(diagramId) or sc.withDiagram(id).dc",
      );
    }
    return this.dcFor(this.spaceOpts.diagramId);
  }

  // ─── Reads (READ-ONLY — keep in sync with SC_SDK_READONLY_METHODS) ─

  /** READ-ONLY. List diagrams in the workspace. */
  async listWorkspaceDiagrams(workspaceId?: string): Promise<WorkspaceDiagramSummary[]> {
    const id = this.requireWorkspaceId(workspaceId);
    const { data, error } = await this.sb
      .from("diagrams")
      .select("id, title, description, updated_at, user_id")
      .eq("workspace_id", id)
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as WorkspaceDiagramSummary[];
  }

  /** READ-ONLY. List workspace members + their roles. */
  async listWorkspaceMembers(workspaceId?: string): Promise<WorkspaceMemberSummary[]> {
    const id = this.requireWorkspaceId(workspaceId);
    const { data, error } = await this.sb
      .from("workspace_members")
      .select("user_id, role")
      .eq("workspace_id", id);
    if (error) throw new Error(error.message);
    return (data ?? []) as WorkspaceMemberSummary[];
  }

  /** READ-ONLY. Fetch all workspace variables (raw rows). */
  async getWorkspaceVariables(
    workspaceId?: string,
  ): Promise<Array<{ name: string; value: unknown; definition: unknown }>> {
    const id = this.requireWorkspaceId(workspaceId);
    const { data, error } = await this.sb
      .from("workspace_variables")
      .select("name, value, definition")
      .eq("workspace_id", id);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ name: string; value: unknown; definition: unknown }>;
  }

  /** READ-ONLY. Workspace structural snapshot — name + diagrams. Folder /
   *  sub-workspace arrays are placeholders for forward-compat. */
  async getWorkspaceStructure(workspaceId?: string): Promise<WorkspaceStructureNode> {
    const id = this.requireWorkspaceId(workspaceId);
    const { data: ws, error } = await this.sb
      .from("workspaces")
      .select("id, name, description")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!ws) throw new NotFoundError(`Workspace not found: ${id}`);
    const diagrams = await this.listWorkspaceDiagrams(id);
    return {
      id: (ws as { id: string }).id,
      name: (ws as { name: string }).name,
      description: (ws as { description: string | null }).description,
      diagrams,
      folders: [] as never[],
      workspaces: [] as never[],
    };
  }

  // ─── Mutations ─────────────────────────────────────────────────

  /** Create a new diagram inside the workspace (optionally seeded with
   *  an element tree, connections, and variables). */
  async createWorkspaceDiagram(
    payload: ImportDiagram,
    opts: { workspaceId?: string; createdBy?: string } = {},
  ): Promise<{ id: string; rootIds: string[] }> {
    const workspaceId = this.requireWorkspaceId(opts.workspaceId);
    if (!payload.title?.trim()) throw new ValidationError("title is required");
    const insertRow: Record<string, unknown> = {
      title: payload.title,
      description: payload.description ?? "",
      workspace_id: workspaceId,
    };
    if (opts.createdBy) insertRow.user_id = opts.createdBy;
    const { data: row, error } = await this.sb
      .from("diagrams")
      .insert(insertRow)
      .select("id")
      .single();
    if (error || !row) {
      throw new Error(`createWorkspaceDiagram insert failed: ${error?.message ?? "no id returned"}`);
    }
    const diagramId = (row as { id: string }).id;

    let rootIds: string[] = [];
    if (payload.elements?.length) {
      const tree = await insertElementTree(this.sb, diagramId, null, payload.elements);
      rootIds = tree.rootIds ?? [];
      if (payload.connections?.length) {
        await insertConnections(this.sb, diagramId, tree.nameToId, payload.connections);
      }
      if (payload.variables?.length) {
        const defaultScopeId = await resolveParentByPath(this.sb, diagramId, null);
        await insertVariables(this.sb, diagramId, payload.variables, defaultScopeId, tree.nameToId);
      }
    }
    return { id: diagramId, rootIds };
  }

  /** Upsert (insert or update by name) a batch of workspace variables. */
  async setWorkspaceVariables(
    variables: ImportVariable[],
    opts: { workspaceId?: string; createdBy?: string } = {},
  ): Promise<{ upserted: number }> {
    const workspaceId = this.requireWorkspaceId(opts.workspaceId);
    let count = 0;
    for (const v of variables) {
      if (!v.name?.trim()) continue;
      const row: Record<string, unknown> = {
        workspace_id: workspaceId,
        name: v.name,
        value: v.value ?? null,
        definition: v.definition ?? {},
      };
      if (opts.createdBy) row.created_by = opts.createdBy;
      const { error } = await this.sb
        .from("workspace_variables")
        .upsert(row, { onConflict: "workspace_id,name" });
      if (error) throw new Error(`setWorkspaceVariables: ${error.message}`);
      count++;
    }
    return { upserted: count };
  }

  /** Delete a workspace variable by name. */
  async deleteWorkspaceVariable(
    name: string,
    workspaceId?: string,
  ): Promise<{ deleted: boolean }> {
    const id = this.requireWorkspaceId(workspaceId);
    const { error, count } = await this.sb
      .from("workspace_variables")
      .delete({ count: "exact" })
      .eq("workspace_id", id)
      .eq("name", name);
    if (error) throw new Error(error.message);
    return { deleted: (count ?? 0) > 0 };
  }

  /** Import a full ImportWorkspace tree: creates listed diagrams,
   *  upserts workspace variables, and (forward-compat) accepts nested
   *  workspaces today as no-ops. Idempotent on title unless `overwrite`
   *  is set. */
  async importWorkspaceTree(
    tree: ImportWorkspace,
    opts: { workspaceId?: string; createdBy?: string; overwrite?: boolean } = {},
  ): Promise<{ diagramIds: string[]; variablesUpserted: number }> {
    const workspaceId = this.requireWorkspaceId(opts.workspaceId);
    const diagramIds: string[] = [];
    let variablesUpserted = 0;

    if (tree.variables?.length) {
      const { upserted } = await this.setWorkspaceVariables(tree.variables, {
        workspaceId,
        createdBy: opts.createdBy,
      });
      variablesUpserted += upserted;
    }
    for (const d of tree.diagrams ?? []) {
      if (!opts.overwrite) {
        const { data: existing } = await this.sb
          .from("diagrams")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("title", d.title)
          .maybeSingle();
        if (existing) {
          diagramIds.push((existing as { id: string }).id);
          continue;
        }
      }
      const { id } = await this.createWorkspaceDiagram(d, {
        workspaceId,
        createdBy: opts.createdBy,
      });
      diagramIds.push(id);
    }
    // Sub-workspaces: data model does not yet support nesting; accepted
    // in the payload for forward-compat but produces nothing today.
    return { diagramIds, variablesUpserted };
  }

  /** Route an ImportDiagramElement seed to the right importer. */
  async importSeed(
    seed: ImportDiagramElement,
    opts: { workspaceId?: string; createdBy?: string; overwrite?: boolean } = {},
  ): Promise<{ diagramIds: string[]; variablesUpserted: number }> {
    if (seed.kind === "workspace") {
      return await this.importWorkspaceTree(seed, opts);
    }
    const { id } = await this.createWorkspaceDiagram(seed, opts);
    return { diagramIds: [id], variablesUpserted: 0 };
  }
}
