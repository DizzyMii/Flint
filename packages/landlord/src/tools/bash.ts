import { tool } from 'flint';
import type { Tool } from 'flint';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execAsync = promisify(exec);

const bashSchema = z.object({ command: z.string() });

export function bashTool(workDir: string): Tool {
  return tool({
    name: 'bash',
    description: 'Execute a shell command in the tenant working directory. Returns stdout + stderr combined.',
    input: bashSchema,
    jsonSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    handler: async ({ command }) => {
      const { stdout, stderr } = await execAsync(command, { cwd: workDir });
      const combined = [stdout, stderr].filter(Boolean).join('\n');
      return combined || '(no output)';
    },
  }) as unknown as Tool;
}
