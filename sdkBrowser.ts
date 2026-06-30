// Browser-side factory for the shared DiagramCraftClient SDK.
//
// Phase 3: tutorial scripts (`run_script` / `run_script_async`) receive a
// preconstructed `it.dc` so authors can perform mutations against the active
// diagram with the user's own RLS privileges — no service role exposed.
//
// We wire an `activityLogger` so every mutation the script performs through
// `it.dc.*` shows up in the diagram activity log (tutorial auto-complete
// steps, `run_script` mutations, etc.). Without this hook the audit feed
// silently drops every tutorial-driven change.

import { supabase } from "@/integrations/supabase/client";
import { DiagramCraftClient, type SdkActivityLogger } from "@shared/sdk/DiagramCraftClient.ts";
import { logActivity } from "@/lib/activityLog";

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

/** Shared "everything routed through SDK is a tutorial/script edit" logger. */
export const browserSdkActivityLogger: SdkActivityLogger = (evt) => {
  void logActivity({
    diagramId: evt.diagramId,
    eventType: evt.eventType,
    targetKind: evt.targetKind ?? null,
    targetId: evt.targetId ?? null,
    targetLabel: evt.targetLabel ?? null,
    payload: { ...(evt.payload ?? {}), via: "sdk" },
    actorKind: "system",
  });
};

/** Construct a DiagramCraftClient bound to the user's session. */
export function createBrowserSdk(diagramId?: string | null): DiagramCraftClient {
  const id = diagramId ?? getCurrentDiagramIdFromUrl();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new DiagramCraftClient(supabase as any, {
    ...(id ? { diagramId: id } : {}),
    activityLogger: browserSdkActivityLogger,
  });
}
