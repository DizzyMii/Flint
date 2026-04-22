import { tool } from 'flint';
import type { Tool } from 'flint';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { z } from 'zod';

function guardPath(workDir: string, userPath: string): string {
  const abs = resolve(workDir, userPath);
  const rel = relative(workDir, abs);
  if (rel.startsWith('..')) {
    throw new Error(`Path '${userPath}' is outside the working directory`);
  }
  return abs;
}

const readSchema = z.object({ path: z.string() });
const writeSchema = z.object({ path: z.string(), content: z.string() });

export function fileReadTool(workDir: string): Tool {
  return tool({
    name: 'file_read',
    description: 'Read a file relative to the working directory.',
    input: readSchema,
    jsonSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: async ({ path }) => {
      const abs = guardPath(workDir, path);
      return readFile(abs, 'utf-8');
    },
  }) as unknown as Tool;
}

export function fileWriteTool(workDir: string): Tool {
  return tool({
    name: 'file_write',
    description: 'Write content to a file relative to the working directory. Creates parent directories.',
    input: writeSchema,
    jsonSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    handler: async ({ path, content }) => {
      const abs = guardPath(workDir, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf-8');
      return `Written ${content.length} bytes to ${path}`;
    },
  }) as unknown as Tool;
}
