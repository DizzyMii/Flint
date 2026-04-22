import type { Budget } from 'flint/budget';
import type { ProviderAdapter, Result, Tool } from 'flint';
import type { Contract } from './contract.ts';
import { decompose } from './decompose.ts';
import { runTenant } from './tenant.ts';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export class DependencyCycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DependencyCycleError';
  }
}

export function resolveOrder(contracts: Contract[]): Contract[] {
  const byRole = new Map(contracts.map(c => [c.role, c]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(contracts.map(c => [c.role, WHITE]));
  const order: Contract[] = [];

  function visit(role: string, stack: string[]): void {
    if (color.get(role) === GRAY) {
      throw new DependencyCycleError(`Dependency cycle: ${[...stack, role].join(' -> ')}`);
    }
    if (color.get(role) === BLACK) return;
    if (!byRole.has(role)) return;
    color.set(role, GRAY);
    for (const dep of byRole.get(role)!.dependsOn) {
      visit(dep, [...stack, role]);
    }
    color.set(role, BLACK);
    order.push(byRole.get(role)!);
  }

  for (const c of contracts) visit(c.role, []);
  return order;
}

export type TenantOutcome =
  | { status: 'complete'; artifacts: Record<string, unknown> }
  | { status: 'escalated'; lastError: string; retriesExhausted: number };

export type OrchestrateResult = {
  status: 'complete' | 'partial';
  tenants: Record<string, TenantOutcome>;
  artifacts: Record<string, Record<string, unknown>>;
};

export type LandlordEvent =
  | { type: 'tenant_started'; role: string }
  | { type: 'checkpoint_passed'; role: string; checkpoint: string }
  | { type: 'checkpoint_failed'; role: string; checkpoint: string; reason: string }
  | { type: 'tenant_complete'; role: string }
  | { type: 'tenant_evicted'; role: string; reason: string; retry: number }
  | { type: 'tenant_escalated'; role: string }
  | { type: 'job_complete'; artifacts: Record<string, Record<string, unknown>> };

export type OrchestratorConfig = {
  adapter: ProviderAdapter;
  landlordModel: string;
  tenantModel: string;
  /** Shared job-level budget consumed by ALL tenants and the landlord decompose call. */
  budget?: Budget;
  outputDir?: string;
  onEvent?: (event: LandlordEvent) => void;
};

export async function orchestrate(
  prompt: string,
  toolsFactory: (workDir: string) => Tool[],
  config: OrchestratorConfig,
): Promise<Result<OrchestrateResult>> {
  // Decompose
  const decomposeResult = await decompose(prompt, {
    adapter: config.adapter,
    model: config.landlordModel,
    ...(config.budget !== undefined ? { budget: config.budget } : {}),
  });
  if (!decomposeResult.ok) return decomposeResult;
  const plan = decomposeResult.value;

  try {
    resolveOrder(plan);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
  }

  const baseOutputDir = config.outputDir ?? join(tmpdir(), `landlord-${Date.now()}`);
  await mkdir(join(baseOutputDir, 'shared'), { recursive: true });

  // Per-role gate: resolves with artifacts when the tenant completes
  const gates = new Map<string, { promise: Promise<Record<string, unknown>>; resolve: (v: Record<string, unknown>) => void }>();
  for (const c of plan) {
    let resolve!: (v: Record<string, unknown>) => void;
    const promise = new Promise<Record<string, unknown>>(r => { resolve = r; });
    gates.set(c.role, { promise, resolve });
  }

  const escalatedRoles = new Set<string>();
  const tenantOutcomes: Record<string, TenantOutcome> = {};
  const jobArtifacts: Record<string, Record<string, unknown>> = {};

  async function runWithRetry(contract: Contract): Promise<void> {
    // Wait for dependencies
    for (const dep of contract.dependsOn) {
      await gates.get(dep)!.promise;
      if (escalatedRoles.has(dep)) {
        const lastError = `Dependency '${dep}' escalated before this tenant could start`;
        escalatedRoles.add(contract.role);
        tenantOutcomes[contract.role] = { status: 'escalated', lastError, retriesExhausted: 0 };
        gates.get(contract.role)!.resolve({});
        config.onEvent?.({ type: 'tenant_escalated', role: contract.role });
        return;
      }
    }

    // Build shared context from dependencies
    const sharedArtifacts: Record<string, unknown> = {};
    for (const dep of contract.dependsOn) {
      const depArtifacts = jobArtifacts[dep] ?? {};
      for (const [k, v] of Object.entries(depArtifacts)) {
        sharedArtifacts[`${dep}.${k}`] = v;
      }
    }

    const workDir = join(baseOutputDir, contract.role);
    await mkdir(workDir, { recursive: true });

    config.onEvent?.({ type: 'tenant_started', role: contract.role });

    let lastError: string | undefined;

    for (let attempt = 0; attempt < contract.maxRetries; attempt++) {
      const result = await runTenant(
        contract,
        toolsFactory(workDir),
        {
          adapter: config.adapter,
          model: config.tenantModel,
          ...(config.budget !== undefined ? { budget: config.budget } : {}),
          workDir,
        },
        lastError,
        Object.keys(sharedArtifacts).length > 0 ? sharedArtifacts : undefined,
      );

      if (result.ok) {
        jobArtifacts[contract.role] = result.value;
        tenantOutcomes[contract.role] = { status: 'complete', artifacts: result.value };
        gates.get(contract.role)!.resolve(result.value);
        config.onEvent?.({ type: 'tenant_complete', role: contract.role });
        return;
      }

      lastError = result.error.message;
      config.onEvent?.({ type: 'tenant_evicted', role: contract.role, reason: lastError, retry: attempt + 1 });
    }

    // All retries exhausted
    escalatedRoles.add(contract.role);
    tenantOutcomes[contract.role] = {
      status: 'escalated',
      lastError: lastError ?? 'unknown',
      retriesExhausted: contract.maxRetries,
    };
    gates.get(contract.role)!.resolve({});
    config.onEvent?.({ type: 'tenant_escalated', role: contract.role });
  }

  await Promise.all(plan.map(c => runWithRetry(c)));

  const allComplete = Object.values(tenantOutcomes).every(o => o.status === 'complete');
  const status = allComplete ? 'complete' : 'partial';
  config.onEvent?.({ type: 'job_complete', artifacts: jobArtifacts });

  return {
    ok: true,
    value: { status, tenants: tenantOutcomes, artifacts: jobArtifacts },
  };
}
