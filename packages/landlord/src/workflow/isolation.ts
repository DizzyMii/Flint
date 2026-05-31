import { exec } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export type IsolationLease = { workDir: string; release: () => Promise<void> };

export interface IsolationBackend {
  acquire(label: string): Promise<IsolationLease>;
}

function sanitize(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'agent';
}

export function workdirIsolation(baseDir: string): IsolationBackend {
  let counter = 0;
  return {
    async acquire(label) {
      const workDir = join(baseDir, `${sanitize(label)}-${counter++}`);
      await mkdir(workDir, { recursive: true });
      return { workDir, release: async () => {} };
    },
  };
}

export function gitWorktreeIsolation(repoDir: string, baseDir: string): IsolationBackend {
  const fallback = workdirIsolation(baseDir);
  let counter = 0;
  return {
    async acquire(label) {
      try {
        await execAsync('git rev-parse --is-inside-work-tree', { cwd: repoDir });
      } catch {
        return fallback.acquire(label);
      }
      const workDir = join(baseDir, `wt-${sanitize(label)}-${counter++}`);
      try {
        await execAsync(`git worktree add --detach ${JSON.stringify(workDir)}`, { cwd: repoDir });
      } catch {
        return fallback.acquire(label);
      }
      return {
        workDir,
        release: async () => {
          try {
            await execAsync(`git worktree remove --force ${JSON.stringify(workDir)}`, {
              cwd: repoDir,
            });
          } catch {
            /* leave the worktree for inspection if removal fails */
          }
        },
      };
    },
  };
}
