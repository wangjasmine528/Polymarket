/**
 * 将模块 2/3/4 挂到模块 1 的 candidates 上（供 prediction seed 使用）。
 * 支持：降级（无 LLM）与真实 Anthropic（模块 3 P_llm + 模块 4 三阶段）。
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import {
  buildSeedProbabilityEstimate,
  buildProbabilityPrompt,
  parseLlmProbabilityJson,
  buildFusedProbabilityEstimateFromLlmParse,
} from './_polymarket-probability.mjs';
import {
  stubModule4Decision,
  extractFirstJsonObject,
  runModule4LlmPipeline,
} from './_polymarket-multi-agent.mjs';
import {
  parsePolymarketSnapshotJsonl,
  detectSmartMoneyFromSnapshots,
} from './_polymarket-smart-money.mjs';

const MODULE3_LLM_SYSTEM = '你是预测市场分析师。只输出一段 JSON，不要 markdown 围栏以外的解释。';

async function runModule3LlmForCandidate(candidate, allCandidates, callLlm) {
  const user = buildProbabilityPrompt({
    eventTitle: candidate.title,
    eventDescription: '',
    expiryDate: candidate.endDate ?? '',
    marketPrice: candidate.currentPrice,
    newsContext:
      '（Seed 批处理：暂无独立新闻正文管道；请主要依据标题、到期日与当前市价隐含概率推理。）',
  });
  const text = await callLlm({ system: MODULE3_LLM_SYSTEM, user });
  const parsed = parseLlmProbabilityJson(extractFirstJsonObject(text));
  return buildFusedProbabilityEstimateFromLlmParse(parsed, candidate, allCandidates);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slimAgentValidationStub(out) {
  return {
    mode: out.mode,
    judge: out.judge,
    kelly: out.kelly,
    edge: out.edge,
    oppositeEdge: out.oppositeEdge,
  };
}

function slimAgentValidationLlm(out) {
  return {
    mode: out.mode,
    judge: out.judge,
    kelly: out.kelly,
    edge: out.edge,
    oppositeEdge: out.oppositeEdge,
    bull: out.bull,
    bear: out.bear,
  };
}

function buildSmartMoneyPayload(c, byId, counters) {
  const row = c.source === 'polymarket' ? byId.get(String(c.marketId)) : null;
  if (row) counters.smartMoneyAttached += 1;

  const smartMoney = row
    ? {
        available: true,
        marketId: row.marketId,
        question: row.question,
        bars: row.bars,
        volumeBars: row.volumeBars,
        triggered: row.detection.triggered,
        score: row.detection.score,
        signals: row.detection.signals,
        gateReason: row.gateReason || null,
        insufficientBySignal: row.insufficientBySignal,
      }
    : {
        available: false,
        reason:
          c.source !== 'polymarket'
            ? 'not_polymarket_source'
            : byId.size === 0
              ? 'no_snapshot_records'
              : 'market_not_in_snapshot',
      };

  const smStub = row
    ? { triggered: row.detection.triggered, score: row.detection.score, signals: row.detection.signals }
    : { triggered: false, score: 0, signals: [] };

  return { smartMoney, smStub };
}

/**
 * @param {string} filePath 绝对或相对 cwd 的路径
 * @returns {{ path: string, loaded: boolean, records: ReturnType<typeof parsePolymarketSnapshotJsonl> }}
 */
export async function loadOptionalPolymarketSnapshotJsonl(filePath) {
  if (!filePath) {
    return { path: '', loaded: false, records: [] };
  }
  try {
    if (!existsSync(filePath)) {
      return { path: filePath, loaded: false, records: [] };
    }
    const raw = await readFile(filePath, 'utf8');
    const records = parsePolymarketSnapshotJsonl(raw);
    return { path: filePath, loaded: true, records };
  } catch {
    return { path: filePath, loaded: false, records: [] };
  }
}

/**
 * @param {object[]} candidates buildModule1Candidates 输出
 * @param {object[]} snapshotRecords parsePolymarketSnapshotJsonl 结果（可空数组）
 * @param {object} [options]
 * @param {object} [options.smartMoneyOpts] detectSmartMoneyFromSnapshots 选项
 * @param {number} [options.module4Bankroll]
 */
export function enrichCandidatesWithModules234(candidates, snapshotRecords, options = {}) {
  const smartOpts = options.smartMoneyOpts ?? {};
  const bankroll = Number(options.module4Bankroll ?? 10_000);
  const byId = new Map();
  if (Array.isArray(snapshotRecords) && snapshotRecords.length > 0) {
    for (const row of detectSmartMoneyFromSnapshots(snapshotRecords, smartOpts)) {
      byId.set(String(row.marketId), row);
    }
  }

  const counters = { smartMoneyAttached: 0 };
  const enriched = candidates.map((c) => {
    const { smartMoney, smStub } = buildSmartMoneyPayload(c, byId, counters);
    const probabilityEstimate = buildSeedProbabilityEstimate(c, candidates);
    const agentValidation = slimAgentValidationStub(
      stubModule4Decision(
        {
          title: c.title,
          description: '',
          endDate: c.endDate ?? '',
          side: c.side,
          currentPrice: c.currentPrice,
          pTrue: probabilityEstimate.pTrue,
          smartMoney: smStub,
          liquidity: c.liquidity,
          volume24h: c.volume24h,
        },
        { bankroll: Number.isFinite(bankroll) && bankroll > 0 ? bankroll : 10_000 },
      ),
    );
    return { ...c, smartMoney, probabilityEstimate, agentValidation };
  });

  return {
    candidates: enriched,
    stats: {
      snapshotMarketsDetected: byId.size,
      smartMoneyAttached: counters.smartMoneyAttached,
      candidateCount: candidates.length,
      llmCandidatesAttempted: 0,
      llmCandidatesSucceeded: 0,
      llmCandidatesFailed: 0,
      llmMaxConfigured: 0,
      useLlm: false,
    },
  };
}

/**
 * @param {(opts: { system: string, user: string }) => Promise<string>} callLlm
 * @param {object} [options]
 * @param {boolean} [options.useLlm]
 * @param {number} [options.llmMaxCandidates] 仅前 N 条 candidate 走真实 LLM（控制费用/时延）
 * @param {number} [options.llmDelayMs] 每条 LLM 候选开始前间隔（毫秒）
 */
export async function enrichCandidatesWithModules234Async(candidates, snapshotRecords, options = {}) {
  const smartOpts = options.smartMoneyOpts ?? {};
  const bankroll = Number(options.module4Bankroll ?? 10_000);
  const br = Number.isFinite(bankroll) && bankroll > 0 ? bankroll : 10_000;
  const useLlm = Boolean(options.useLlm && typeof options.callLlm === 'function');
  const llmMax = Math.max(0, Math.min(Number(options.llmMaxCandidates ?? 5), candidates.length));
  const delayMs = Math.max(0, Number(options.llmDelayMs ?? 450));

  const byId = new Map();
  if (Array.isArray(snapshotRecords) && snapshotRecords.length > 0) {
    for (const row of detectSmartMoneyFromSnapshots(snapshotRecords, smartOpts)) {
      byId.set(String(row.marketId), row);
    }
  }

  const counters = { smartMoneyAttached: 0 };
  let llmCandidatesAttempted = 0;
  let llmCandidatesSucceeded = 0;
  let llmCandidatesFailed = 0;

  const enriched = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const { smartMoney, smStub } = buildSmartMoneyPayload(c, byId, counters);

    const useLlmForThis = useLlm && i < llmMax;
    if (useLlmForThis) {
      llmCandidatesAttempted += 1;
      if (delayMs > 0 && llmCandidatesAttempted > 1) await sleep(delayMs);
      try {
        const probabilityEstimate = await runModule3LlmForCandidate(c, candidates, options.callLlm);

        const module4Out = await runModule4LlmPipeline(
          {
            title: c.title,
            description: '',
            endDate: c.endDate ?? '',
            side: c.side,
            currentPrice: c.currentPrice,
            pTrue: probabilityEstimate.pTrue,
            smartMoney: smStub,
            liquidity: c.liquidity,
            volume24h: c.volume24h,
          },
          options.callLlm,
          { bankroll: br },
        );

        enriched.push({
          ...c,
          smartMoney,
          probabilityEstimate,
          agentValidation: slimAgentValidationLlm(module4Out),
        });
        llmCandidatesSucceeded += 1;
      } catch (err) {
        llmCandidatesFailed += 1;
        if (llmCandidatesFailed === 1) {
          const msg = err instanceof Error ? err.message : String(err);
          const label = c?.marketId || c?.title || `#${i}`;
          console.warn(`  polymarket seed LLM: first failure (candidate ${label}): ${msg}`);
        }
        const probabilityEstimate = buildSeedProbabilityEstimate(c, candidates);
        const fallbackProb = {
          ...probabilityEstimate,
          llmFallbackError: err instanceof Error ? err.message : String(err),
        };
        enriched.push({
          ...c,
          smartMoney,
          probabilityEstimate: fallbackProb,
          agentValidation: slimAgentValidationStub(
            stubModule4Decision(
              {
                title: c.title,
                description: '',
                endDate: c.endDate ?? '',
                side: c.side,
                currentPrice: c.currentPrice,
                pTrue: probabilityEstimate.pTrue,
                smartMoney: smStub,
                liquidity: c.liquidity,
                volume24h: c.volume24h,
              },
              { bankroll: br },
            ),
          ),
        });
      }
    } else {
      const probabilityEstimate = buildSeedProbabilityEstimate(c, candidates);
      const agentValidation = slimAgentValidationStub(
        stubModule4Decision(
          {
            title: c.title,
            description: '',
            endDate: c.endDate ?? '',
            side: c.side,
            currentPrice: c.currentPrice,
            pTrue: probabilityEstimate.pTrue,
            smartMoney: smStub,
            liquidity: c.liquidity,
            volume24h: c.volume24h,
          },
          { bankroll: br },
        ),
      );
      enriched.push({ ...c, smartMoney, probabilityEstimate, agentValidation });
    }
  }

  return {
    candidates: enriched,
    stats: {
      snapshotMarketsDetected: byId.size,
      smartMoneyAttached: counters.smartMoneyAttached,
      candidateCount: candidates.length,
      llmCandidatesAttempted,
      llmCandidatesSucceeded,
      llmCandidatesFailed,
      llmMaxConfigured: llmMax,
      useLlm,
    },
  };
}
