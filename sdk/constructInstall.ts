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
  isImportDiagramSeed,
  isImportWorkspaceSeed,
  type ImportDiagramElement,
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
    if (!row.import_seed || !isImportWorkspaceSeed(row.import_seed)) {
      throw new ValidationError(
        "workspace-target construct must have import_seed of kind:'workspace'",
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
