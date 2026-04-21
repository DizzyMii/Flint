# Flint Roadmap — v0 → v1 and beyond

**Last updated:** 2026-04-21  
**Current state:** v0, not published to npm. Core + Anthropic adapter are working. OpenAI-compat is a stub.

---

## Milestone 0.1 — Multi-provider support

**Goal:** `call()` and `stream()` work against any OpenAI-compatible endpoint. No `NotImplementedError` anywhere.

### Tasks

- [ ] Implement request serialization: Flint `Message[]` + `Tool[]` → OpenAI Chat Completions format
- [ ] Implement response normalization: OpenAI `choices[0]` → `NormalizedResponse` (`Message`, `Usage`, `StopReason`)
- [ ] Implement SSE streaming: parse `data: {...}` lines → `StreamChunk` discriminated union
- [ ] Implement tool call handling: OpenAI `tool_calls` array → `ToolCall` type
- [ ] Write unit tests for request serializer (input → output snapshot)
- [ ] Write unit tests for response normalizer (mock OpenAI response → NormalizedResponse)
- [ ] Write streaming unit tests (mock SSE stream → StreamChunk[])
- [ ] Test manually against OpenAI (gpt-4o), Groq (llama-3.3-70b), Ollama (llama3.2 local)
- [ ] Remove `NotImplementedError` stub and the stub guard in `index.ts`
- [ ] Remove `:::warning v0 stub` callout from `docs/adapters/openai-compat.md`
- [ ] Write changeset entry for `@flint/adapter-openai-compat`

### Success criteria

- `call()` returns a correct `Result<CallOutput>` against OpenAI, Groq, and Ollama (verified manually)
- `stream()` emits `text`, `usage`, and `end` chunks in correct order against all three
- Tool calls round-trip correctly: model calls a tool → execute → result injected → model responds
- All existing tests pass (`pnpm test`)
- No `NotImplementedError` reachable from any public export

---

## Milestone 0.2 — API hardening

**Goal:** Every public API either frozen or explicitly marked as unstable with a clear scope. No more "may change" surprises.

### Tasks

- [ ] Audit all public exports in `packages/flint/src/index.ts` — mark each as stable or unstable
- [ ] Finalize `compress/summarize` — confirm `SummarizeOpts` shape is final; write tests for the happy path and the fail-open behavior
- [ ] Finalize recipes API — run all 4 recipes (react, retryValidate, reflect, summarize) against a live model; fix any signature issues found
- [ ] Decide graph scope for v1: what's in (graph definition, run, runStream, checkpoint) vs deferred (visualization, distributed runners)
- [ ] Stabilize graph's public API surface if it's in scope; add v0 deferral note to docs if it's out
- [ ] Remove `:::warning v0 API` callouts from pages whose APIs are now frozen (primitives, budget, safety, adapters)
- [ ] Rewrite `docs/guide/v0-status.md` → `Stability Policy`: what's stable, what's not, and why
- [ ] Write a `BREAKING_CHANGES.md` policy: what requires a major bump, minor, patch
- [ ] Add `"exports"` integrity check to CI: a script that imports every documented subpath and fails if any throw

### Success criteria

- Every public subpath export (`flint`, `flint/memory`, `flint/rag`, etc.) imports cleanly in a plain TypeScript consumer project
- All 4 recipes produce correct output in an end-to-end test
- Stability Policy doc clearly states which APIs are guaranteed stable for v1
- Zero v0 warning callouts on pages whose APIs are stable

---

## Milestone 0.3 — First npm publish

**Goal:** `npm install flint @flint/adapter-anthropic` works on a fresh machine.

### Tasks

- [ ] Decide publish scope: which packages ship with 0.3? (propose: `flint`, `@flint/adapter-anthropic`, `@flint/adapter-openai-compat`; defer `@flint/graph` until 0.4)
- [ ] Add `"prepublishOnly": "pnpm build"` to each package's `package.json`
- [ ] Verify `"files"` field in each `package.json` includes `dist/` and excludes `src/`, `__tests__/`
- [ ] Verify TypeScript declaration files (`.d.ts`) are emitted and included
- [ ] Create npm org `@flint` (or confirm `flint` unscoped is available)
- [ ] Add `NPM_TOKEN` secret to GitHub repo settings
- [ ] Add GitHub Actions publish workflow: trigger on `changeset publish`, run `pnpm changeset publish`
- [ ] Run `pnpm changeset` to create initial version entries
- [ ] Run `pnpm changeset version` to apply versions
- [ ] Dry-run: `pnpm changeset publish --dry-run` — verify tarball contents
- [ ] Publish: `pnpm changeset publish`
- [ ] Confirm packages appear on npmjs.com with correct README, types, and version
- [ ] Update README badges: replace `img.shields.io/badge/version-v0-orange` with live npm version badge
- [ ] Update VitePress home page hero: remove "v0 · under development" pill or update to show version

### Success criteria

- `npm install flint @flint/adapter-anthropic` succeeds in a blank Node 20 project
- TypeScript types resolve correctly (`tsc --noEmit` passes on a consumer project)
- `call()` with the Anthropic adapter works in the freshly installed package
- npm page for `flint` shows the correct README, description, and version

---

## Milestone 1.0 — Stability declaration

**Goal:** Commit to semver. No breaking changes without a major version bump.

### Tasks

- [ ] Final audit: every export in every package matches its documentation exactly (run the exports integrity check from 0.2)
- [ ] Remove all remaining `:::warning v0` callouts from docs
- [ ] Update `docs/guide/v0-status.md` → rename to `docs/guide/stability.md`, rewrite for v1
- [ ] Update sidebar and nav to remove v0 status link; add Changelog link instead
- [ ] Write `CHANGELOG.md` entry for 1.0.0 covering the full journey from v0
- [ ] Run `pnpm changeset` with major bump for all packages
- [ ] Publish `1.0.0` to npm
- [ ] Create GitHub Release `v1.0.0` with full release notes (what's stable, what's coming in v1.x)
- [ ] Update README: replace v0 install warning with clean install block; update badges to show `1.0.0`
- [ ] Update VitePress hero: remove "v0 · under development" subtext
- [ ] Pin a GitHub Discussion or issue as the official "Flint 1.0 announcement" thread

### Success criteria

- npm shows `1.0.0` for all published packages
- Zero v0-related warnings anywhere in the docs site
- GitHub Release v1.0.0 exists with comprehensive notes
- Any future breaking change would require publishing `2.0.0` — team agrees on this

---

## v1.x — Growth (unordered, prioritize by demand)

| Item | What it unlocks |
|---|---|
| `@flint/adapter-gemini` | Google models via Vertex AI / Gemini API |
| `@flint/adapter-bedrock` | AWS Bedrock (Claude, Llama, etc.) |
| Persistent RAG store adapter | Pinecone, Qdrant, pgvector that satisfy `VectorStore` |
| Graph v1 — production-ready | Stable DSL, distributed checkpointing, visualization |
| Streaming in `agent()` | `onStep` receives live `StreamChunk[]`, not just final output |
| Token-aware chunking in `chunk()` | Split by token count (not chars) using a tokenizer |
| CLI — `flint init` | Scaffold an agent project with adapter choice |
| TypeDoc supplement | Auto-generated type reference alongside hand-written guides |

---

## What determines priority within milestones

1. **Blocking user adoption** — anything that throws at runtime blocks everyone
2. **Correctness over features** — a correct small API beats a big broken one
3. **Documentation keeps pace** — nothing ships without its doc page updated

---

## How to use this roadmap

- Each task is a PR or a commit — small enough to review in one sitting
- "Success criteria" are the definition of done for the milestone, not individual tasks
- After each milestone: cut a changeset, publish, and update this document
