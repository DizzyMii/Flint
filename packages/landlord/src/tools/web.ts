import { tool } from 'flint';
import type { Tool } from 'flint';
import { z } from 'zod';

const webSchema = z.object({ url: z.string() });

export function webFetchTool(_workDir: string): Tool {
  return tool({
    name: 'web_fetch',
    description: 'Fetch a URL and return the response body as text.',
    input: webSchema,
    jsonSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    handler: async ({ url }) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      return response.text();
    },
  }) as unknown as Tool;
}
