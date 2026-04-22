# Tool Approval Flow

This example shows how to gate destructive tool calls behind a human approval step using `requireApproval()`.

## What this demonstrates

- `requireApproval()` — wrapping tools with an approval callback
- Handling approval denial gracefully
- Building a CLI confirmation prompt

## Setup

```ts
import { agent, tool } from 'flint';
import { budget } from 'flint/budget';
import { requireApproval } from 'flint/safety';
import { anthropicAdapter } from '@flint/adapter-anthropic';
import * as v from 'valibot';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });
```

## Define the tools

```ts
const deleteFile = tool({
  name: 'delete_file',
  description: 'Delete a file from the filesystem',
  input: v.object({ path: v.string() }),
  handler: async ({ path }) => {
    await import('node:fs/promises').then(fs => fs.unlink(path));
    return `Deleted ${path}`;
  },
  permissions: { destructive: true, filesystem: true },
});

const readFile = tool({
  name: 'read_file',
  description: 'Read a file',
  input: v.object({ path: v.string() }),
  handler: async ({ path }) => import('node:fs/promises').then(fs => fs.readFile(path, 'utf-8')),
  permissions: { filesystem: true },
});
```

## Build the approval callback

```ts
const rl = readline.createInterface({ input: stdin, output: stdout });

async function askUser(toolName: string, input: unknown): Promise<boolean> {
  const answer = await rl.question(
    `\n⚠️  Agent wants to call: ${toolName}(${JSON.stringify(input)})\nAllow? [y/N] `
  );
  return answer.trim().toLowerCase() === 'y';
}
```

## Wrap destructive tools with approval

```ts
// Only gate tools with permissions.destructive === true
const safeTools = requireApproval(
  [deleteFile, readFile],
  async (toolName, input) => {
    const t = [deleteFile, readFile].find(t => t.name === toolName);
    if (t?.permissions?.destructive) {
      return askUser(toolName, input);
    }
    return true; // auto-approve non-destructive tools
  }
);
```

## Run the agent

```ts
const res = await agent({
  adapter,
  model: 'claude-opus-4-7',
  messages: [
    {
      role: 'user',
      content: 'Clean up the temp directory by deleting all .tmp files, then show me what\'s left.',
    },
  ],
  tools: safeTools,
  budget: budget({ maxSteps: 10 }),
});

rl.close();

if (res.ok) {
  console.log('\nAgent:', res.value.message.content);
}
```

## Example interaction

```
Agent wants to call: delete_file({"path":"./temp/cache.tmp"})
Allow? [y/N] y

Agent wants to call: delete_file({"path":"./temp/session.tmp"})
Allow? [y/N] n

Agent: I deleted cache.tmp but you denied deleting session.tmp.
The remaining files in temp/ are: session.tmp, readme.txt
```

## What happens when denied

When the approval callback returns `false`, the tool returns an error message to the agent: `"Tool execution denied by user"`. The agent receives this as a tool result and typically adjusts its plan:

```
Tool result: Error: Tool execution denied by user
Agent: I understand you'd like to keep session.tmp. I'll leave it in place.
```

## See also

- [Safety](/features/safety) — full safety API including requireApproval
- [tool()](/primitives/tool) — ToolPermissions type
- [agent()](/primitives/agent) — agent loop API
