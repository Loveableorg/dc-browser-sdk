// Construct install router — single entry point for "instantiate this
// construct against a destination" used by:
//
//   - Replayable session bootstrap (start_replayable_session follow-up)
//   - MCP `install_construct` (Phase 2)
//   - UI install/play actions
//
// Reads a construct row from any catalog table (private / workspace /
// instance) and dispatches by `target_kind`:
//
//   target_kind = 'diagram'    → DiagramCraftClient.scaffoldBaseDiagram
//                                under the destination diagram. Mirrors
//                                the pre-workspace-constructs flow; uses
//                                `base_diagram` jsonb (legacy) OR an
//                                `import_seed` of kind:"diagram" if the
//                                construct was authored with the new
//                                shape.
//
//   target_kind = 'workspace'  → SpaceCraftClient.importSeed(seed) under
//                                the destination workspace. seed MUST be
//                                kind:"workspace" (validated by the DB
//                                trigger when replayable=true; enforced
//                                client-side here for the read path).
//
// Pure logic — caller supplies a SupabaseClient and the row. No reads
// of the catalog tables happen here so the caller can RPC them with
// whatever auth path is correct (SECURITY DEFINER helpers, direct
// SELECTs under RLS, etc.).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  findLaunchPoint,
  isImportDiagramSeed,
  isImportWorkspaceSeed,
  type ImportDiagramElement,
  type ImportWorkspace,
} from "../domain/constructImport.ts";
import type { ImportElement, ImportConnection, ImportVariable } from "../domain/types.ts";
import { SpaceCraftClient } from "./SpaceCraftClient.ts";
import { ValidationError } from "../errors/index.ts";
import {
  insertConnections,
  insertElementTree,
  insertVariables,
  resolveParentByPath,
} from "../diagram/tree.ts";

/** Shape this router needs from a catalog row. All three catalog tables
 *  (workspace_constructs / private_constructs / public_construct_submissions)
 *  expose these fields after the Phase 1 migration. */
export interface InstallableConstruct {
  id: string;
  target_kind: "diagram" | "workspace";
  /** Legacy single-diagram scaffold payload. Used when target_kind='diagram'
   *  AND no import_seed is set. */
  base_diagram?: unknown;
  /** New discriminated-union seed payload. Required when
   *  target_kind='workspace'; optional (overrides base_diagram) when
   *  target_kind='diagram'. */
  import_seed?: ImportDiagramElement | null;
}

export interface InstallToDiagramOpts {
  /** Destination diagram the construct attaches to. */
  diagramId: string;
  /** Optional parent element under which to scaffold (defaults to root). */
  parentElementId?: string | null;
  createdBy?: string;
}

export interface InstallToWorkspaceOpts {
  /** Destination workspace the construct seeds into. */
  workspaceId: string;
  /** Defaults to false — when true, overwrites diagrams with matching titles
   *  rather than skipping them. */
  overwrite?: boolean;
  createdBy?: string;
}

export type InstallOpts = InstallToDiagramOpts | InstallToWorkspaceOpts;

export interface InstallResult {
  /** Always present — newly-created diagram ids (length 1 for diagram-kind
   *  installs, length 0..N for workspace-kind installs). */
  diagramIds: string[];
  /** Workspace-variable upserts (0 for diagram-kind installs). */
  variablesUpserted: number;
  /** Root element ids scaffolded under the destination diagram. Only set
   *  for diagram-kind installs targeting an existing diagram. */
  rootElementIds?: string[];
}

/** Narrow the seed payload for a diagram-target construct. Accepts both
 *  the new `import_seed` (preferred) and the legacy `base_diagram` jsonb. */
function diagramSeedFrom(row: InstallableConstruct): {
  elements: ImportElement[];
  connections: ImportConnection[];
  variables: ImportVariable[];
} {
  if (row.import_seed && isImportDiagramSeed(row.import_seed)) {
    return {
      elements: row.import_seed.elements ?? [],
      connections: row.import_seed.connections ?? [],
      variables: row.import_seed.variables ?? [],
    };
  }
  // Legacy base_diagram shape — could be an array of elements OR an object
  // { elements, connections, variables }. Be permissive.
  const bd = row.base_diagram;
  if (Array.isArray(bd)) {
    return { elements: bd as ImportElement[], connections: [], variables: [] };
  }
  if (bd && typeof bd === "object") {
    const o = bd as Record<string, unknown>;
    return {
      elements: (o.elements as ImportElement[]) ?? [],
      connections: (o.connections as ImportConnection[]) ?? [],
      variables: (o.variables as ImportVariable[]) ?? [],
    };
  }
  return { elements: [], connections: [], variables: [] };
}

/** Install a construct into its destination. Validates that opts match
 *  the construct's target_kind. */
export async function installConstruct(
  sb: SupabaseClient,
  row: InstallableConstruct,
  opts: InstallOpts,
): Promise<InstallResult> {
  if (row.target_kind === "workspace") {
    if (!("workspaceId" in opts)) {
      throw new ValidationError(
        "workspace-target construct requires InstallToWorkspaceOpts (workspaceId)",
      );
    }
    // Seed is OPTIONAL for non-replayable workspace constructs (starters and
    // archetypes) — they may exist purely to drive step playback. The DB
    // trigger still enforces "replayable=true requires a workspace seed".
    if (!row.import_seed) {
      return { diagramIds: [], variablesUpserted: 0 };
    }
    if (!isImportWorkspaceSeed(row.import_seed)) {
      throw new ValidationError(
        "workspace-target construct seed must be kind:'workspace'",
      );
    }
    const sc = new SpaceCraftClient(sb, { workspaceId: opts.workspaceId });
    const res = await sc.importSeed(row.import_seed, {
      workspaceId: opts.workspaceId,
      createdBy: opts.createdBy,
      overwrite: opts.overwrite ?? false,
    });
    return { diagramIds: res.diagramIds, variablesUpserted: res.variablesUpserted };
  }

  // target_kind === 'diagram'
  if (!("diagramId" in opts)) {
    throw new ValidationError(
      "diagram-target construct requires InstallToDiagramOpts (diagramId)",
    );
  }
  const seed = diagramSeedFrom(row);
  const parentId = opts.parentElementId ?? null;
  const tree = await insertElementTree(sb, opts.diagramId, parentId, seed.elements);
  if (seed.connections.length) {
    await insertConnections(sb, opts.diagramId, tree.nameToId, seed.connections);
  }
  if (seed.variables.length) {
    const defaultScopeId = await resolveParentByPath(sb, opts.diagramId, null);
    await insertVariables(sb, opts.diagramId, seed.variables, defaultScopeId, tree.nameToId);
  }
  return {
    diagramIds: [opts.diagramId],
    variablesUpserted: 0,
    rootElementIds: tree.rootIds ?? [],
  };
}


/** Fetch a construct row from the appropriate catalog table and install
 *  it. Thin convenience for MCP `install_construct` + replayable bootstrap
 *  callers so they don't have to know which table holds which lane. */
export type CatalogLane = "private" | "workspace" | "instance";

function tableForLane(lane: CatalogLane): string {
  switch (lane) {
    case "private":   return "private_constructs";
    case "workspace": return "workspace_constructs";
    case "instance":  return "custom_tutorials";
  }
}

export async function installConstructFromCatalog(
  sb: SupabaseClient,
  args: { lane: CatalogLane; constructId: string; opts: InstallOpts },
): Promise<InstallResult> {
  const table = tableForLane(args.lane);

  // `custom_tutorials` (instance lane) predates the target_kind /
  // import_seed columns. Read only what exists there and synthesize the
  // InstallableConstruct shape for backwards compatibility with old
  // diagram tutorial formats: `kind='starter'` becomes a workspace-target
  // install whose seed is derived from `base_diagram` (which may already
  // be an ImportWorkspace, or a legacy diagram tree we wrap into a
  // single-diagram workspace seed). Other kinds remain diagram-target
  // and continue to scaffold from `base_diagram`.
  if (args.lane === "instance") {
    const { data, error } = await sb
      .from(table)
      .select("id, kind, label, diagram_title, description, base_diagram")
      .eq("id", args.constructId)
      .maybeSingle();
    if (error) throw new ValidationError(error.message);
    if (!data) throw new ValidationError(`Construct not found in ${table}: ${args.constructId}`);
    const isStarter = data.kind === "starter";
    const target_kind: "diagram" | "workspace" = isStarter ? "workspace" : "diagram";
    let import_seed: ImportDiagramElement | null = null;
    if (isStarter) {
      const bd = data.base_diagram as unknown;
      if (bd && typeof bd === "object" && (bd as { kind?: string }).kind === "workspace") {
        import_seed = bd as ImportDiagramElement;
      } else {
        // Legacy diagram-shape base_diagram → wrap into a workspace seed
        // containing a single diagram so SpaceCraftClient.importSeed runs.
        const legacy = diagramSeedFrom({
          id: data.id,
          target_kind: "diagram",
          base_diagram: bd,
          import_seed: null,
        });
        import_seed = {
          kind: "workspace",
          name: data.label,
          description: data.description ?? null,
          diagrams: [{
            title: data.diagram_title || data.label,
            description: data.description ?? null,
            elements: legacy.elements,
            connections: legacy.connections,
            variables: legacy.variables,
          }],
        };
      }
    }
    const row: InstallableConstruct = {
      id: data.id,
      target_kind,
      base_diagram: data.base_diagram,
      import_seed,
    };
    return await installConstruct(sb, row, args.opts);
  }

  const { data, error } = await sb
    .from(table)
    .select("id, kind, topic_id, label, replayable, has_mutations, target_kind, base_diagram, import_seed")
    .eq("id", args.constructId)
    .maybeSingle();
  if (error) throw new ValidationError(error.message);
  if (!data) throw new ValidationError(`Construct not found in ${table}: ${args.constructId}`);
  const row: InstallableConstruct = {
    id: data.id,
    target_kind: (data.target_kind ?? "diagram") as "diagram" | "workspace",
    base_diagram: data.base_diagram,
    import_seed: data.import_seed ?? null,
  };
  const result = await installConstruct(sb, row, args.opts);

  // Post-install hooks for workspace-target constructs. Splits by replayable:
  //
  //   replayable=true  → record a persistent `replayable_installs` Play badge
  //                      anchored to the launch-point diagram (or workspace).
  //                      No tutorial_sessions row here — launching is the user
  //                      clicking the badge later.
  //
  //   replayable=false → spawn a one-shot floating `tutorial_sessions` row so
  //                      the steps play immediately via the user-wide
  //                      Realtime subscription in TutorialProvider.
  if (
    row.target_kind === "workspace" &&
    "workspaceId" in args.opts &&
    args.opts.createdBy
  ) {
    if (data.replayable) {
      // Find the anchor in the seed (workspace-seed only).
      let anchorDiagramId: string | null = null;
      let anchorWorkspaceId: string | null = null;
      const seed = row.import_seed;
      if (seed && isImportWorkspaceSeed(seed)) {
        const lp = findLaunchPoint(seed as ImportWorkspace);
        if (lp?.kind === "diagram") {
          // Find the diagram by title among the diagrams imported this call.
          const wsId = args.opts.workspaceId;
          const { data: match } = await sb
            .from("diagrams")
            .select("id")
            .eq("workspace_id", wsId)
            .eq("title", lp.title)
            .maybeSingle();
          if (match) anchorDiagramId = (match as { id: string }).id;
        }
      }
      if (!anchorDiagramId) {
        anchorWorkspaceId = args.opts.workspaceId;
      }
      const installScope = args.lane === "private" ? "user" : "workspace";
      const { error: insErr } = await sb.from("replayable_installs").insert({
        source_lane: args.lane,
        source_construct_id: data.id,
        topic_id: data.topic_id,
        label: data.label,
        has_mutations: (data as { has_mutations?: boolean }).has_mutations ?? false,
        install_scope: installScope,
        workspace_id: args.opts.workspaceId,
        installed_by: args.opts.createdBy,
        anchor_diagram_id: anchorDiagramId,
        anchor_workspace_id: anchorWorkspaceId,
      });
      // Ignore duplicate-key (re-install for an already-installed badge);
      // surface every other error.
      if (insErr && (insErr as { code?: string }).code !== "23505") {
        throw new ValidationError(`replayable_installs insert: ${insErr.message}`);
      }
    } else {
      const stepsTable = args.lane === "private"
        ? "private_construct_steps"
        : "workspace_construct_steps";
      const { count: stepCount } = await sb
        .from(stepsTable)
        .select("id", { count: "exact", head: true })
        .eq("construct_id", data.id);
      if ((stepCount ?? 0) > 0) {
        await sb.from("tutorial_sessions").insert({
          user_id: args.opts.createdBy,
          diagram_id: null,
          workspace_id: args.opts.workspaceId,
          topic_id: data.topic_id,
          total_steps: stepCount ?? 0,
          current_step: 0,
          phase: "intro",
          is_completed: false,
          is_replayable: false,
          archetype_label: data.label,
          scope_element_id: null,
          source_lane: args.lane,
          source_construct_id: data.id,
          variable_values: {},
        });
      }
    }
  }

  return result;
}

