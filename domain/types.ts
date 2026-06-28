// Cross-runtime domain types shared by browser (@shared alias) and
// Supabase edge functions (../_shared/lib/...). Pure TypeScript — no
// runtime deps. Mirror of the Zod schemas in ../schemas/import.ts.
//
// Keep this file authoritative for the *shapes* the platform accepts as
// input from MCP tools, the future api-v1 REST endpoint, and the
// in-tutorial DiagramCraftClient SDK. The Zod schemas validate; this
// file types.

export interface ImportConnection {
  start_element_name: string;
  end_element_name: string;
  start_shape?: string;
  end_shape?: string;
  line_color?: string;
  start_label?: string | null;
  middle_label?: string | null;
  end_label?: string | null;
}

/** Permissive shape for a variable definition. Browser code narrows this
 *  to its richer `VariableDefinition` type at the call site. */
export type VariableDefinitionLike = Record<string, unknown>;

export interface ImportVariable {
  name: string;
  definition?: VariableDefinitionLike;
  value?: unknown;
  /** For TOP-LEVEL `variables` only: scope to an existing element by name. */
  scope_element_name?: string | null;
  sort_order?: number;
}

export interface ImportElement {
  name: string;
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
  /** Plain text OR base64. Server auto-detects and encodes plaintext for storage. */
  source_code?: string | null;
  file_name?: string | null;
  is_project_root?: boolean;
  git_repo_url?: string | null;
  /** Branch to fetch from / push to. Defaults to repo default branch. */
  git_branch?: string | null;
  /** Provider hint. Inferred from URL when omitted. */
  git_provider?: "github" | "gitlab" | "bitbucket" | "generic" | null;
  auto_fetch_on_import?: boolean;
  /** Push-state: open PR/MR remembered between push sessions. */
  git_open_pr_branch?: string | null;
  git_open_pr_url?: string | null;
  git_open_pr_number?: number | null;
  referenced_diagram_id?: string | null;
  children?: ImportElement[];
  connections?: ImportConnection[];
  variables?: ImportVariable[];
}

export interface ImportTreePayload {
  elements: ImportElement[];
  connections?: ImportConnection[];
  variables?: ImportVariable[];
  resolve_templates?: boolean;
}

/** `children_mode` for upsert_element. `replace` (default) wipes existing
 *  children before inserting; `merge` recursively upserts by name and
 *  preserves untouched siblings. */
export type ChildrenMode = "replace" | "merge";
