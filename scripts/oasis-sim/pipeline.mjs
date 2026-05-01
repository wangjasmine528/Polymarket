// @ts-check

import { readAllInputs } from '../seed-regional-snapshots.mjs';
import { computeBalanceVector } from '../regional-snapshot/balance-vector.mjs';
import { evaluateTriggers } from '../regional-snapshot/trigger-evaluator.mjs';
import { OasisMockAdapter } from './adapters/oasis-adapter.mjs';
import { runHypothesisAgent } from './agents/hypothesis-agent.mjs';
import { runEvidenceAgent } from './agents/evidence-agent.mjs';
import { runAdjudicatorAgent } from './agents/adjudicator-agent.mjs';

/**
 * @param {string[]} warnings
 * @returns {Promise<Record<string, any>>}
 */
export async function readSourcesSafeForOasis(warnings) {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return {};
  }
  try {
    const { sources } = await readAllInputs();
    return sources;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Redis pipeline read failed: ${msg}`);
    return {};
  }
}

/**
 * @typedef {import('./types.mjs').PredictedEvent} PredictedEvent
 * @typedef {import('./types.mjs').OrchestrationTrace} OrchestrationTrace
 */

/**
 * @param {{
 *   regionId: string
 *   horizon: '24h' | '7d' | '30d'
 *   dryRun: boolean
 *   startedAt: number
 *   sources: Record<string, any>
 * }} opts
 * @returns {Promise<{ events: PredictedEvent[]; trace: OrchestrationTrace[]; warnings: string[] }>}
 */
export async function runOasisThreeAgentPipeline(opts) {
  const { regionId, horizon, dryRun, startedAt, sources } = opts;
  const warnings = [];

  const { vector: balance } = computeBalanceVector(regionId, sources);
  const triggers = evaluateTriggers(regionId, sources, balance);

  const context = {
    regionId,
    horizon,
    dryRun,
    startedAt,
    sources,
  };

  const adapter = new OasisMockAdapter();
  adapter.registerAgent('hypothesis', runHypothesisAgent);
  adapter.registerAgent('evidence', runEvidenceAgent);
  adapter.registerAgent('adjudicator', runAdjudicatorAgent);

  const [hypothesisResult] = await adapter.runWorkflow(context, [
    { id: 'hypothesis-1', agent: 'hypothesis', payload: { triggers } },
  ]);
  const [evidenceResult] = await adapter.runWorkflow(context, [
    {
      id: 'evidence-1',
      agent: 'evidence',
      payload: { candidates: hypothesisResult?.output?.candidates ?? [] },
    },
  ]);
  const [adjudicatorResult] = await adapter.runWorkflow(context, [
    {
      id: 'adjudicator-1',
      agent: 'adjudicator',
      payload: { candidates: evidenceResult?.output?.candidates ?? [] },
    },
  ]);

  warnings.push(...(hypothesisResult?.warnings ?? []));
  warnings.push(...(evidenceResult?.warnings ?? []));
  warnings.push(...(adjudicatorResult?.warnings ?? []));

  return {
    events: adjudicatorResult?.output?.events ?? [],
    trace: adapter.emitTrace(),
    warnings: [...new Set(warnings)],
  };
}
