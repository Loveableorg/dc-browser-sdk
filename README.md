# dc-browser-sdk

**Read-only mirror.** Source of truth lives in the private
DiagramCraft repository; this repository is overwritten on
every push to `main` by the `mirror-dc-sdk` GitHub Action.

Do not open pull requests here — they cannot be merged
upstream and will be wiped on the next sync.

## What this is

The browser-facing SDK that powers `it.dc` inside DiagramCraft
tutorial scripts and the in-app runtime. `DiagramCraftClient`
is transport-agnostic: it takes a `SupabaseClient` and runs
with whatever privileges that client carries (anon = browser
RLS as the signed-in user; service role = elevated edge
access). No privilege escalation happens inside the SDK.

## Layout

- `sdkBrowser.ts` — browser factory that binds a
  `DiagramCraftClient` to the current Supabase session and
  (optionally) the current diagram id derived from the URL.
- `sdk/DiagramCraftClient.ts` — the SDK class itself.
- `domain/`, `diagram/`, `encoding/`, `errors/`, `tutorial/`
  — the cross-runtime helpers the SDK depends on. Published
  as-is purely so the SDK file is self-explanatory; they are
  not a stable public API.

## Conventions

All code here is pure TypeScript and uses only universal
APIs (`fetch`, `TextEncoder`/`TextDecoder`, `atob`/`btoa`,
`crypto.subtle`, `URL`, `structuredClone`). Imports keep
their explicit `.ts` extensions so the same files run in
both Vite (browser) and Deno (Supabase Edge Functions)
without transformation.

Generated $(date -u +"%Y-%m-%dT%H:%M:%SZ") from commit
${GITHUB_SHA}.
