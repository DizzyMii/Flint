# Flint vs LangChain — README Section Design

**Date:** 2026-04-22  
**Status:** Approved  
**Target file:** `README.md`  
**Placement:** New `## Flint vs LangChain` section, inserted immediately before `## Why Flint`

---

## Goal

Add a section to the Flint README that helps developers who know LangChain understand what Flint is, how it differs philosophically, and what the migration or comparison looks like in concrete code.

---

## Section Structure

### 1. Narrative block

3–4 sentences covering the philosophy gap:

- LangChain models everything as a class hierarchy (LLMs, chains, agents, tools) and abstracts over providers with its own mental model. You learn LangChain, then use it to talk to models.
- Flint is plain async functions. You learn the Anthropic (or OpenAI) API, and Flint gives you thin, well-typed helpers on top. TypeScript is the glue, not a framework.
- LangChain brings a large transitive dependency tree (dozens of packages, peer deps per provider). Flint has one runtime dependency (`@standard-schema/spec`) and two install-time packages for a typical setup.
- Error handling: LangChain throws. Flint returns `Result<T>` — no try/catch at call sites.

### 2. Side-by-side code comparisons

Four comparisons, each as two sequential labeled code blocks — **LangChain** then **Flint** — under a shared `###` heading. GitHub Markdown has no native two-column layout; sequential blocks are the standard README pattern.

#### 2a. Installation
- LangChain: `npm install langchain @langchain/anthropic @langchain/core`
- Flint: `npm install flint @flint/adapter-anthropic`

#### 2b. Basic LLM call
- LangChain: instantiate `ChatAnthropic`, call `.invoke([new HumanMessage(...)])`, get back a `BaseMessage`
- Flint: `call({ adapter, model, messages })` returns `Promise<Result<CallResult>>`

#### 2c. Tool definition
- LangChain: `tool(handler, { name, description, schema: z.object(...) })` from `@langchain/core/tools`
- Flint: `tool({ name, description, input: v.object(...), handler })` — any Standard Schema library (Zod, Valibot, ArkType)

#### 2d. Agent loop
- LangChain: `createReactAgent({ llm, tools })` + `new AgentExecutor({ agent, tools })` + `.invoke({ input })`
- Flint: `agent({ adapter, model, messages, tools, budget: budget({ maxSteps: 5 }) })`

---

## Placement in README

```
## Install
## Quick start
## What you get
## Packages
## Flint vs LangChain   ← new section here
## Why Flint
## Documentation
## Contributing
## License
```

---

## Out of Scope

- No LangChain migration guide (separate doc if needed)
- No comparison with LlamaIndex, Vercel AI SDK, or other frameworks in this section
- No performance benchmarks
