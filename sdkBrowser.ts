// Browser-side factory for the shared DiagramCraftClient SDK.
//
// Phase 3: tutorial scripts (`run_script` / `run_script_async`) receive a
// preconstructed `it.dc` so authors can perform mutations against the active
// diagram with the user's own RLS privileges — no service role exposed.

import { supabase } from "@/integrations/supabase/client";
import { DiagramCraftClient } from "@shared/sdk/DiagramCraftClient.ts";

/**
 * Best-effort extraction of the diagram id the user is currently viewing,
 * from the route pattern `/diagram/:id`. Returns null if not on a diagram
 * route; callers can still construct the SDK and pass a diagramId per call.
 */
export function getCurrentDiagramIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const m = window.location.pathname.match(/\/diagram\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

/** Construct a DiagramCraftClient bound to the user's session. */
export function createBrowserSdk(diagramId?: string | null): DiagramCraftClient {
  const id = diagramId ?? getCurrentDiagramIdFromUrl();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new DiagramCraftClient(supabase as any, id ? { diagramId: id } : {});
}

