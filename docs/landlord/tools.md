# Standard Tools

`@flint/landlord` ships three built-in tools for tenant agents. They are scoped to a `workDir` sandbox — tenants can read, write, and execute within their work directory but cannot escape it.

## Import

```ts
import { standardTools } from '@flint/landlord/tools';
// or import individually:
import { bashTool, fileReadTool, fileWriteTool, webFetchTool } from '@flint/landlord/tools';
```

## standardTools(workDir)

Returns all four tools pre-configured for the given work directory:

```ts
function standardTools(workDir: string): Tool[]
// returns [bashTool(workDir), fileReadTool(workDir), fileWriteTool(workDir), webFetchTool()]
```

Pass this factory to `orchestrate()`:

```ts
const result = await orchestrate(prompt, (workDir) => standardTools(workDir), config);
```

---

## bashTool

Executes shell commands with `workDir` as the current working directory.

**Tool name:** `bash`

**Input schema:**
```ts
{ command: string }  // the shell command to run
```

**Returns:** stdout + stderr as a string, or an error message if the command fails.

**Sandbox:** The command runs in a child process with `cwd: workDir`. Tenants cannot `cd` outside the work directory using relative paths, but absolute paths are not blocked — for stricter sandboxing, use `toolsDenied: ['bash']` and provide only file tools.

**Example tool call (from agent):**
```json
{ "name": "bash", "arguments": { "command": "npm init -y && npm install express" } }
```

**Example usage in orchestrate:**
```ts
// Allow bash for a code-writing tenant
const contract = {
  ...
  toolsAllowed: ['bash', 'file_read', 'file_write'],
};
```

---

## fileReadTool

Reads a file relative to `workDir`.

**Tool name:** `file_read`

**Input schema:**
```ts
{ path: string }  // relative path from workDir
```

**Returns:** File contents as a string, or an error message if the file doesn't exist.

**Security:** Rejects paths containing `../` (path traversal guard). The path must stay within `workDir`.

**Example:**
```json
{ "name": "file_read", "arguments": { "path": "src/index.ts" } }
```

---

## fileWriteTool

Writes or creates a file relative to `workDir`. Creates parent directories automatically.

**Tool name:** `file_write`

**Input schema:**
```ts
{ path: string; content: string }
```

**Returns:** Success confirmation or error message.

**Security:** Same path traversal guard as `fileReadTool`.

**Example:**
```json
{ "name": "file_write", "arguments": { "path": "src/server.ts", "content": "import express..." } }
```

---

## webFetchTool

Performs an HTTP GET request and returns the response body.

**Tool name:** `web_fetch`

**Input schema:**
```ts
{ url: string }
```

**Returns:** Response body truncated to ~8000 characters to prevent context overflow. Returns error message on network failure.

**Example:**
```json
{ "name": "web_fetch", "arguments": { "url": "https://api.github.com/repos/microsoft/typescript/releases/latest" } }
```

---

## Custom tools

Combine standard tools with your own:

```ts
import { standardTools } from '@flint/landlord/tools';
import { tool } from 'flint';
import * as v from 'valibot';

const dbQueryTool = tool({
  name: 'db_query',
  description: 'Run a read-only SQL query',
  input: v.object({ sql: v.string() }),
  handler: async ({ sql }) => {
    const rows = await db.query(sql);
    return JSON.stringify(rows.slice(0, 50)); // limit output size
  },
});

const result = await orchestrate(
  prompt,
  (workDir) => [...standardTools(workDir), dbQueryTool],
  config
);
```

## Restricting tools per tenant

Use `contract.toolsAllowed` or `contract.toolsDenied` to restrict which tools a tenant can use:

```ts
// Researcher tenant: only web fetch, no file writes or bash
{ role: 'researcher', toolsAllowed: ['web_fetch'], ... }

// Writer tenant: file tools only, no web or bash
{ role: 'writer', toolsAllowed: ['file_read', 'file_write'], ... }

// Reviewer tenant: read-only
{ role: 'reviewer', toolsAllowed: ['file_read', 'web_fetch'], ... }
```

## See also

- [orchestrate()](/landlord/orchestrate) — pass toolsFactory
- [runTenant()](/landlord/tenant) — pass tools array directly
- [Contracts](/landlord/contract) — toolsAllowed / toolsDenied fields
