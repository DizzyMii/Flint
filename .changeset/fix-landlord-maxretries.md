---
"landlord": patch
---

Validate `maxRetries` on a contract as a positive integer. It was previously an unconstrained `z.number()`, so negative or zero values silently caused a tenant to escalate without ever running, and fractional values produced an unexpected extra attempt in the `attempt < maxRetries` loop. The schema now enforces `int().min(1)`.
