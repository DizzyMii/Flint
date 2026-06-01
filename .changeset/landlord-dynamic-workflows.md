---
"landlord": minor
---

Add a dynamic-workflow runtime: author workflows as typed functions (`defineWorkflow`) or model-written JS scripts (`runWorkflowScript`) that orchestrate subagents via `agent`/`parallel`/`pipeline`/`phase`/`log`/`args`/`budget`/`workflow` hooks, with structured-output schemas, concurrency/agent caps, resume/journaling, a determinism sandbox, an agent-type registry, isolation backends, and a model-facing `workflowTool`. `orchestrate()` is now built on this runtime (API unchanged).
