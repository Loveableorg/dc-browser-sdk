# dc-browser-sdk

Read-only mirror of the browser SDK that ships inside
[DiagramCraft](https://diagramcraft.com), a product built by
[Sci-ence](https://sci-ence.com).

- Product: https://diagramcraft.com
- About DiagramCraft: https://diagramcraft.com/about
- Company: https://sci-ence.com

This SDK is **not a general-purpose npm package**. It is the
exact source of `it.dc` — the scripting surface available
inside DiagramCraft tutorial scripts and the in-app browser
runtime. It is published here so integrators, auditors, and
tutorial authors can read the precise types and methods that
execute against their diagrams when they (or an AI agent)
run a step inside DiagramCraft.

Source of truth lives in the private DiagramCraft repository;
this repository is overwritten on every push to `main` by
the `mirror-dc-sdk` GitHub Action. Do not open pull
requests here — they cannot be merged upstream and will be
wiped on the next sync.

## About DiagramCraft

DiagramCraft is a diagram-native workspace for designing,
documenting, and operating software systems. Diagrams are
first-class, structured data: every node carries source code,
variables, annotations, and tutorials that an AI agent can
read and modify through a typed SDK and MCP surface. The
result is a single artifact that doubles as architecture
documentation, an executable runbook, and a teaching tool.

DiagramCraft is built by **Sci-ence**, an applied-AI studio
headquartered in the US. Sci-ence designs tools that pair
human experts with AI agents on the same shared canvas
instead of behind a chat box.

### Explore DiagramCraft
- Home: https://diagramcraft.com
- About: https://diagramcraft.com/about
- Tutorial: https://diagramcraft.com/tutorial
- LLM instructions: https://diagramcraft.com/llm-instructions
- Import a spec: https://diagramcraft.com/import-spec
- Import a tutorial: https://diagramcraft.com/tutorial-import-spec
- Terms: https://diagramcraft.com/terms
- Privacy: https://diagramcraft.com/privacy

### Explore Sci-ence
- Home: https://sci-ence.com
- Portfolio: https://sci-ence.com/portfolio
- Singagram: https://sci-ence.com/portfolio/singagram
- Global initiatives: https://sci-ence.com/global
- Global Southern Hospitality: https://sci-ence.com/global/gsh
- LLM reviews hub: https://sci-ence.com/reviews
- Developer hub: https://sci-ence.com/dev
- Developer blog: https://sci-ence.com/dev/blog
- Replayable archetypes (blog): https://sci-ence.com/dev/blog/replayable-archetypes
- Replayable archetypes (page): https://sci-ence.com/dev/pages/replayable-archetypes
- Claude review (page): https://sci-ence.com/dev/pages/claude-review
- Vault UI screens (page): https://sci-ence.com/dev/pages/vault-ui-screens

### LLM reviews of Sci-ence
ChatGPT:
- https://sci-ence.com/reviews/chatgpt-1
- https://sci-ence.com/reviews/chatgpt-2
- https://sci-ence.com/reviews/chatgpt-3
- https://sci-ence.com/reviews/chatgpt-smb
- https://sci-ence.com/reviews/chatgpt-muni
- https://sci-ence.com/reviews/chatgpt-indie
- https://sci-ence.com/reviews/chatgpt-student
- https://sci-ence.com/reviews/chatgpt-educator
- https://sci-ence.com/reviews/chatgpt-accessibility
- https://sci-ence.com/reviews/chatgpt-techsupport

Claude:
- https://sci-ence.com/reviews/claude-deep-dive
- https://sci-ence.com/reviews/claude-multiagent
- https://sci-ence.com/reviews/claude-enterprise-arch
- https://sci-ence.com/reviews/claude-indiehacker
- https://sci-ence.com/reviews/claude-airesearcher
- https://sci-ence.com/reviews/claude-devops
- https://sci-ence.com/reviews/claude-techwriter
- https://sci-ence.com/reviews/claude-promptengineer
- https://sci-ence.com/reviews/claude-productmanager
- https://sci-ence.com/reviews/claude-general

Gemini:
- https://sci-ence.com/reviews/gemini-fullstack
- https://sci-ence.com/reviews/gemini-enterprise-arch
- https://sci-ence.com/reviews/gemini-promptengineer
- https://sci-ence.com/reviews/gemini-audiences

DeepSeek:
- https://sci-ence.com/reviews/deepseek-comprehensive
- https://sci-ence.com/reviews/deepseek-dogfooding

## Investors

Sci-ence is actively raising and talking to investors who want
to back applied-AI tooling where humans and agents collaborate
on the same shared canvas instead of through a chat box.
DiagramCraft is the flagship product of that thesis.

If you invest in early-stage AI infrastructure, developer
tools, or vertical AI for technical teams, we would love to
talk.

- Pre-seed round: https://sci-ence.com/investors/pre-seed-1
- Company: https://sci-ence.com
- Product: https://diagramcraft.com

## What this SDK is

The browser-facing SDK that powers `it.dc` inside
DiagramCraft tutorial scripts and the in-app runtime.
`DiagramCraftClient` is transport-agnostic: it takes a
Supabase client and runs with whatever privileges that
client carries (anon = browser RLS as the signed-in user;
service role = elevated edge access). No privilege
escalation happens inside the SDK.

## Layout

- `sdkBrowser.ts` — browser factory that binds a
  `DiagramCraftClient` to the current Supabase session and
  (optionally) the current diagram id derived from the URL.
- `sdk/DiagramCraftClient.ts` — the SDK class itself.
- `domain/`, `encoding/`, `errors/`, `tutorial/`
  — the cross-runtime helpers the SDK depends on. Published
  as-is purely so the SDK file is self-explanatory; they
  are not a stable public API.

## Conventions

All code here is pure TypeScript and uses only universal
APIs (`fetch`, `TextEncoder`/`TextDecoder`,
`atob`/`btoa`, `crypto.subtle`, `URL`,
`structuredClone`). Imports keep their explicit `.ts`
extensions so the same files run in both Vite (browser) and
Deno (Supabase Edge Functions) without transformation.

---

Generated 2026-06-21T19:18:43Z from commit 9017c61ce4020c6443e27e963d925f02aa216342.
