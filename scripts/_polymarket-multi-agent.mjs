/**
 * 模块 4：多 Agent 验证（TradingAgents 变体）— 纯函数与流水线。
 * 输入：候选市场 + 模块2 K 线/智慧资金信号 + 模块3 概率估算（p_true 等）。
 * 输出：裁判决策（买入 / 跳过 / 做空）+ Kelly 头寸（美元）。
 *
 * LLM 路径通过注入 `callLlm({ system, user }) => string` 便于单测；CLI 使用 Anthropic SDK。
 */

import { evaluateCheaperSideEdge } from './_polymarket-probability.mjs';

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function toProb(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value >= 0 && value <= 1) return value;
  if (value >= 0 && value <= 100) return value / 100;
  return null;
}

/**
 * 设计文档 Kelly：买入价 p_market，赢 (1-p_market)，输 p_market；1/4 Kelly + 上限。
 * @returns {number} 建议投入金额（美元）
 */
export function kellyPositionUsd(pTrue, pMarket, bankroll, maxFraction = 0.05) {
  const p = toProb(pTrue);
  const pM = toProb(pMarket);
  if (p === null || pM === null || pM <= 0 || pM >= 1 || bankroll <= 0) return 0;
  if (p <= pM) return 0;
  const b = (1 - pM) / pM;
  const q = 1 - p;
  const kellyF = (b * p - q) / b;
  const safeF = Math.min(kellyF * 0.25, maxFraction);
  if (!Number.isFinite(safeF) || safeF <= 0) return 0;
  return bankroll * safeF;
}

/** @returns {number} 已含 1/4 Kelly 与 maxFraction 帽的仓位比例（0~maxFraction） */
export function kellySafeFraction(pTrue, pMarket, maxFraction = 0.05) {
  const p = toProb(pTrue);
  const pM = toProb(pMarket);
  if (p === null || pM === null || pM <= 0 || pM >= 1) return 0;
  if (p <= pM) return 0;
  const b = (1 - pM) / pM;
  const q = 1 - p;
  const kellyF = (b * p - q) / b;
  return Math.min(Math.max(kellyF * 0.25, 0), maxFraction);
}

/**
 * 当前腿的对侧二元近似：YES 价 + NO 价 ≈ 1。
 * @param {'yes'|'no'} side
 * @param {number} legPrice 当前交易腿的市价概率（0~1）
 */
export function oppositeLegProbabilities(side, pTrue, legPrice) {
  const p = toProb(pTrue);
  const m = toProb(legPrice);
  if (p === null || m === null) return null;
  if (side === 'yes') {
    return { pWin: 1 - p, pMarket: clamp01(1 - m) };
  }
  if (side === 'no') {
    return { pWin: p, pMarket: clamp01(1 - m) };
  }
  return null;
}

export function formatModule4Context(input) {
  const sm = input.smartMoney ?? {};
  const lines = [
    `标题: ${input.title ?? ''}`,
    `描述: ${input.description ?? ''}`,
    `到期: ${input.endDate ?? ''}`,
    `模块1 方向: ${input.side}（当前腿市价概率）: ${(toProb(input.currentPrice) ?? 0) * 100}%`,
    `模块3 P_true（事件发生）: ${(toProb(input.pTrue) ?? 0) * 100}%`,
    `流动性(如有): ${input.liquidity ?? 'n/a'}`,
    `24h 量(如有): ${input.volume24h ?? 'n/a'}`,
    `模块2 智慧资金: triggered=${sm.triggered ?? false}, score=${sm.score ?? 0}, signals=[${(sm.signals ?? []).join(', ')}]`,
  ];
  return lines.join('\n');
}

export function buildBullSystemPrompt() {
  return '你是预测市场的做多（Bull）分析师。只输出 JSON，不要 markdown。';
}

export function buildBearSystemPrompt() {
  return '你是预测市场的做空（Bear）分析师。只输出 JSON，不要 markdown。';
}

export function buildBullUserPrompt(contextText) {
  return `${contextText}

请站在「支持该腿上涨 / 事件对己方有利」一方：
- 列出最多 3 条支持证据（thesis）
- 最多 2 条你仍承认的风险（risks）
- 立场强度 stance: strong/medium/weak

只输出 JSON：
{"stance":"strong|medium|weak","thesis":["..."],"risks":["..."]}`;
}

export function buildBearUserPrompt(contextText) {
  return `${contextText}

请站在「反对当前定价 / 事件对己方不利或市场过热」一方：
- 列出最多 3 条反对或质疑证据（thesis）
- 最多 2 条多头可能忽视的点（risks）
- 立场强度 stance: strong/medium/weak

只输出 JSON：
{"stance":"strong|medium|weak","thesis":["..."],"risks":["..."]}`;
}

export function buildJudgeSystemPrompt() {
  return '你是风险裁判：综合 Bull 与 Bear 的 JSON 论点、数值 edge 与 Kelly，只输出 JSON。';
}

export function buildJudgeUserPrompt({
  contextText,
  bullJson,
  bearJson,
  numericEdge,
  kellyBuyUsd,
  kellyShortUsd,
}) {
  return `${contextText}

数值参考：
- 当前腿 edge（模块1 方向下）: ${numericEdge.toFixed(4)}（>0 表示模型认为该腿被低估）
- Kelly 建议（若买入当前腿、且 edge>0）: $${kellyBuyUsd.toFixed(2)}
- Kelly 建议（若改押对侧腿、且对侧有 edge）: $${kellyShortUsd.toFixed(2)}

Bull JSON:
${bullJson}

Bear JSON:
${bearJson}

请综合后只输出 JSON（action 必须小写）：
{"action":"buy|skip|short","edge":0.0,"rationale":"...","kellyFraction":0.0,"positionUsd":0.0}

含义：
- buy：买入模块1给出的当前腿（yes/no）
- short：改押对侧腿（二元里等价于「卖出现腿 / 买对侧」的意图）
- skip：不下注

positionUsd 与 kellyFraction 须与非负 Kelly 一致；若无 edge 则 skip 且 positionUsd=0。`;
}

export function extractFirstJsonObject(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Empty LLM response');
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object in LLM response');
  return JSON.parse(body.slice(start, end + 1));
}

export function parseDebateAgentJson(parsed) {
  const stance = String(parsed?.stance || 'weak').toLowerCase();
  return {
    stance: ['strong', 'medium', 'weak'].includes(stance) ? stance : 'weak',
    thesis: Array.isArray(parsed?.thesis) ? parsed.thesis.slice(0, 3).map(String) : [],
    risks: Array.isArray(parsed?.risks) ? parsed.risks.slice(0, 2).map(String) : [],
  };
}

export function parseJudgeDecisionJson(parsed) {
  const action = String(parsed?.action || 'skip').toLowerCase();
  const edge = Number(parsed?.edge);
  const kellyFraction = Number(parsed?.kellyFraction);
  const positionUsd = Number(parsed?.positionUsd);
  const rationale = parsed?.rationale != null ? String(parsed.rationale) : '';
  if (!['buy', 'skip', 'short'].includes(action)) throw new Error('Invalid judge action');
  if (!Number.isFinite(edge)) throw new Error('Invalid judge edge');
  if (!Number.isFinite(kellyFraction) || kellyFraction < 0) throw new Error('Invalid kellyFraction');
  if (!Number.isFinite(positionUsd) || positionUsd < 0) throw new Error('Invalid positionUsd');
  return { action, edge, rationale, kellyFraction, positionUsd };
}

/**
 * 确定性裁判（无 LLM）：用于测试与默认离线运行。
 */
export function stubModule4Decision(input, options = {}) {
  const bankroll = Number(options.bankroll ?? 10_000);
  const maxFraction = Number(options.maxFraction ?? 0.05);
  const edgeMin = Number(options.edgeMin ?? 0.02);
  const pTrue = input.pTrue;
  const currentPrice = input.currentPrice;
  const side = input.side;
  const edgeInfo = evaluateCheaperSideEdge({ pTrue, currentPrice, side });
  const opp = oppositeLegProbabilities(side, pTrue, currentPrice);
  let oppEdge = 0;
  if (opp) {
    oppEdge = opp.pWin - opp.pMarket;
  }
  const kellyBuy = kellyPositionUsd(edgeInfo.sideProb, edgeInfo.marketProb, bankroll, maxFraction);
  const kellyShort = opp
    ? kellyPositionUsd(opp.pWin, opp.pMarket, bankroll, maxFraction)
    : 0;

  const sm = input.smartMoney ?? {};
  const smBoost = sm.triggered === true ? 1 : 0;

  let action = 'skip';
  let positionUsd = 0;
  let kellyFraction = 0;
  let rationale = '';

  if (edgeInfo.edge >= edgeMin && kellyBuy > 0) {
    action = 'buy';
    positionUsd = kellyBuy;
    kellyFraction = positionUsd / bankroll;
    rationale = smBoost
      ? `edge=${edgeInfo.edge.toFixed(3)} 且智慧资金触发，倾向买入当前腿。`
      : `edge=${edgeInfo.edge.toFixed(3)} 超过阈值，Kelly 分配买入当前腿。`;
  } else if (edgeInfo.edge <= -edgeMin && oppEdge >= edgeMin && kellyShort > 0) {
    action = 'short';
    positionUsd = kellyShort;
    kellyFraction = positionUsd / bankroll;
    rationale = `当前腿偏贵(edge=${edgeInfo.edge.toFixed(3)})，对侧 edge=${oppEdge.toFixed(3)}，倾向押对侧。`;
  } else {
    rationale = `edge=${edgeInfo.edge.toFixed(3)}，未达买卖阈值或 Kelly 为 0；sm_triggered=${Boolean(sm.triggered)}。`;
  }

  const bull = {
    stance: edgeInfo.edge > 0 ? 'medium' : 'weak',
    thesis:
      edgeInfo.edge > 0
        ? ['模型隐含概率高于市价', '存在正期望（若 p_true 可靠）']
        : ['市价与模型接近或偏高'],
    risks: ['p_true 估计误差', '流动性与滑点'],
  };
  const bear = {
    stance: edgeInfo.edge < 0 ? 'medium' : 'weak',
    thesis:
      edgeInfo.edge < 0
        ? ['当前腿定价偏乐观', '对侧更有吸引力']
        : ['市场可能已反映信息', '尾部风险未定价'],
    risks: ['事件不确定性', '相关市场联动'],
  };

  return {
    mode: 'stub',
    edge: edgeInfo,
    oppositeEdge: oppEdge,
    bull,
    bear,
    judge: {
      action,
      edge: edgeInfo.edge,
      rationale,
      kellyFraction,
      positionUsd,
    },
    kelly: {
      buyLegUsd: kellyBuy,
      shortLegUsd: kellyShort,
    },
  };
}

/**
 * 完整三阶段 LLM 辩论 + 裁判（需网络与 API Key）。
 * @param {object} input 与 stubModule4Decision 相同字段
 * @param {(opts: { system: string, user: string }) => Promise<string>} callLlm
 */
export async function runModule4LlmPipeline(input, callLlm, options = {}) {
  const bankroll = Number(options.bankroll ?? 10_000);
  const maxFraction = Number(options.maxFraction ?? 0.05);
  const ctx = formatModule4Context(input);
  const edgeInfo = evaluateCheaperSideEdge({
    pTrue: input.pTrue,
    currentPrice: input.currentPrice,
    side: input.side,
  });
  const opp = oppositeLegProbabilities(input.side, input.pTrue, input.currentPrice);
  const kellyBuy = kellyPositionUsd(edgeInfo.sideProb, edgeInfo.marketProb, bankroll, maxFraction);
  const kellyShort = opp
    ? kellyPositionUsd(opp.pWin, opp.pMarket, bankroll, maxFraction)
    : 0;
  const oppEdge = opp ? opp.pWin - opp.pMarket : 0;

  const bullRaw = await callLlm({
    system: buildBullSystemPrompt(),
    user: buildBullUserPrompt(ctx),
  });
  const bearRaw = await callLlm({
    system: buildBearSystemPrompt(),
    user: buildBearUserPrompt(ctx),
  });
  const bull = parseDebateAgentJson(extractFirstJsonObject(bullRaw));
  const bear = parseDebateAgentJson(extractFirstJsonObject(bearRaw));

  const judgeRaw = await callLlm({
    system: buildJudgeSystemPrompt(),
    user: buildJudgeUserPrompt({
      contextText: ctx,
      bullJson: JSON.stringify(bull),
      bearJson: JSON.stringify(bear),
      numericEdge: edgeInfo.edge,
      kellyBuyUsd: kellyBuy,
      kellyShortUsd: kellyShort,
    }),
  });
  const judge = parseJudgeDecisionJson(extractFirstJsonObject(judgeRaw));

  return {
    mode: 'llm',
    edge: edgeInfo,
    oppositeEdge: oppEdge,
    bull,
    bear,
    judge,
    kelly: {
      buyLegUsd: kellyBuy,
      shortLegUsd: kellyShort,
    },
    raw: { bullRaw, bearRaw, judgeRaw },
  };
}
