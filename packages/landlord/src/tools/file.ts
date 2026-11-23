import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { tool } from 'flint';
import type { Tool } from 'flint';
import { z } from 'zod';

function outside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** Deepest existing ancestor, resolved through symlinks. */
async function realAncestor(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

async function guardPath(workDir: string, userPath: string): Promise<string> {
  const abs = resolve(workDir, userPath);
  const root = await realAncestor(workDir);
  // Check both the lexical path and the symlink-resolved one: a link inside workDir must not
  // become a way out of it.
  if (outside(resolve(workDir), abs) || outside(root, await realAncestor(abs))) {
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
      const abs = await guardPath(workDir, path);
      return readFile(abs, 'utf-8');
    },
  }) as unknown as Tool;
}

export function fileWriteTool(workDir: string): Tool {
  return tool({
    name: 'file_write',
    description:
      'Write content to a file relative to the working directory. Creates parent directories.',
    input: writeSchema,
    jsonSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    handler: async ({ path, content }) => {
      const abs = await guardPath(workDir, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf-8');
      return `Written ${content.length} bytes to ${path}`;
    },
  }) as unknown as Tool;
}
