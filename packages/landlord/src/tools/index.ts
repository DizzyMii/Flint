export { fileReadTool, fileWriteTool } from './file.ts';
export { bashTool } from './bash.ts';
export { webFetchTool } from './web.ts';
import type { Tool } from 'flint';
import { fileReadTool, fileWriteTool } from './file.ts';
import { bashTool } from './bash.ts';
import { webFetchTool } from './web.ts';

export function standardTools(workDir: string): Tool[] {
  return [
    fileReadTool(workDir),
    fileWriteTool(workDir),
    bashTool(workDir),
    webFetchTool(workDir),
  ];
}
