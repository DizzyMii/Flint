# landlord

## 0.1.0

### Minor Changes

- 3813912: Add a dynamic-workflow runtime: author workflows as typed functions (`defineWorkflow`) or model-written JS scripts (`runWorkflowScript`) that orchestrate subagents via `agent`/`parallel`/`pipeline`/`phase`/`log`/`args`/`budget`/`workflow` hooks, with structured-output schemas, concurrency/agent caps, resume/journaling, a determinism sandbox, an agent-type registry, isolation backends, and a model-facing `workflowTool`. `orchestrate()` is now built on this runtime (API unchanged).

### Patch Changes

- 3cac220: Validate `maxRetries` on a contract as a positive integer. It was previously an unconstrained `z.number()`, so negative or zero values silently caused a tenant to escalate without ever running, and fractional values produced an unexpected extra attempt in the `attempt < maxRetries` loop. The schema now enforces `int().min(1)`.
- Updated dependencies [af3034d]
- Updated dependencies [cfda49e]
- Updated dependencies [39a1bfe]
  - flint@0.0.1
