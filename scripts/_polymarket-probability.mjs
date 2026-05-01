export const DEFAULT_PROBABILITY_WEIGHTS = {
  llm: 0.4,
  baseRate: 0.2,
  news: 0.25,
  corr: 0.15,
};

const CONFIDENCE_MULTIPLIER = {
  high: 1,
  medium: 0.85,
  low: 0.65,
};

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function toProbability(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value >= 0 && value <= 1) return value;
  if (value >= 0 && value <= 100) return value / 100;
  return null;
}

export function normalizeWeights(weights = DEFAULT_PROBABILITY_WEIGHTS) {
  const merged = {
    ...DEFAULT_PROBABILITY_WEIGHTS,
    ...(weights ?? {}),
  };
  const keys = Object.keys(DEFAULT_PROBABILITY_WEIGHTS);
  const total = keys.reduce((sum, key) => sum + Math.max(Number(merged[key]) || 0, 0), 0);
  if (total <= 0) return { ...DEFAULT_PROBABILITY_WEIGHTS };

  const normalized = {};
  for (const key of keys) normalized[key] = Math.max(Number(merged[key]) || 0, 0) / total;
  return normalized;
}

export function confidenceToMultiplier(confidence) {
  const key = String(confidence || 'medium').toLowerCase();
  return CONFIDENCE_MULTIPLIER[key] ?? CONFIDENCE_MULTIPLIER.medium;
}

export function buildProbabilityPrompt({
  eventTitle,
  eventDescription = '',
  expiryDate = '',
  marketPrice,
  newsContext = '',
}) {
  const price = toProbability(marketPrice);
  if (price === null) throw new Error('marketPrice must be probability in [0,1] or percentage in [0,100]');

  return `你是一位专业的预测市场分析师。

事件：${eventTitle}
描述：${eventDescription}
到期时间：${expiryDate}
当前市场价格（隐含概率）：${(price * 100).toFixed(1)}%

背景信息：
${newsContext}

请分析：
1. 这个事件发生的概率是多少？（给出精确数字，如 0.34）
2. 你的主要依据是什么？（3条以内）
3. 最大的不确定性来源？
4. 置信度（低/中/高）？

只输出 JSON：
{"probability": 0.XX, "reasoning": ["...", "..."], "uncertainty": "...", "confidence": "high/medium/low"}`;
}

export function parseLlmProbabilityJson(rawText) {
  const parsed = typeof rawText === 'string' ? JSON.parse(rawText) : rawText;
  const probability = toProbability(parsed?.probability);
  if (probability === null) throw new Error('LLM probability missing or invalid');
  const confidence = String(parsed?.confidence || 'medium').toLowerCase();
  return {
    probability: clamp01(probability),
    reasoning: Array.isArray(parsed?.reasoning) ? parsed.reasoning.slice(0, 3).map(String) : [],
    uncertainty: parsed?.uncertainty ? String(parsed.uncertainty) : '',
    confidence: ['high', 'medium', 'low'].includes(confidence) ? confidence : 'medium',
  };
}

/**
 * 把新闻情绪信号映射到概率。sentimentScore 推荐范围 [-1, 1]。
 * 例如：-1 => 0.15, 0 => 0.5, +1 => 0.85。
 */
export function sentimentToProbability(sentimentScore, options = {}) {
  const neutral = Number(options.neutral ?? 0.5);
  const scale = Number(options.scale ?? 0.35);
  const score = Number.isFinite(sentimentScore) ? sentimentScore : 0;
  return clamp01(neutral + (score * scale));
}

/**
 * 相关市场概率聚合：可传入 [0.62, 0.58] 或 [{ probability: 0.62, weight: 2 }, ...]
 */
export function aggregateCorrelationProbability(relatedMarkets) {
  if (!Array.isArray(relatedMarkets) || relatedMarkets.length === 0) return null;
  let weightedSum = 0;
  let totalWeight = 0;
  for (const item of relatedMarkets) {
    const prob = typeof item === 'number' ? item : item?.probability;
    const p = toProbability(prob);
    if (p === null) continue;
    const w = Math.max(typeof item === 'number' ? 1 : Number(item?.weight) || 1, 0);
    weightedSum += p * w;
    totalWeight += w;
  }
  if (totalWeight <= 0) return null;
  return clamp01(weightedSum / totalWeight);
}

export function fuseTrueProbability(components, options = {}) {
  const weights = normalizeWeights(options.weights);
  const llm = toProbability(components?.llm);
  const baseRate = toProbability(components?.baseRate);
  const news = toProbability(components?.news);
  const corr = toProbability(components?.corr);

  const fields = [
    ['llm', llm],
    ['baseRate', baseRate],
    ['news', news],
    ['corr', corr],
  ];

  let effectiveWeight = 0;
  let weightedSum = 0;
  for (const [key, value] of fields) {
    if (value === null) continue;
    const w = weights[key];
    weightedSum += value * w;
    effectiveWeight += w;
  }

  if (effectiveWeight <= 0) {
    throw new Error('No valid probability component available for fusion');
  }

  const fused = clamp01(weightedSum / effectiveWeight);
  const llmConfidence = confidenceToMultiplier(options.llmConfidence || 'medium');
  const anchored = clamp01((fused * llmConfidence) + (0.5 * (1 - llmConfidence)));

  return {
    pTrue: anchored,
    pTrueRaw: fused,
    usedWeights: weights,
    components: { llm, baseRate, news, corr },
  };
}

function inferCorrFromPeerYesPrices(candidate, allCandidates) {
  if (!Array.isArray(allCandidates) || allCandidates.length === 0) return null;
  const items = [];
  for (const p of allCandidates) {
    if (p.source !== 'polymarket') continue;
    if (String(p.marketId) === String(candidate.marketId)) continue;
    const yp = p.yesPrice;
    if (typeof yp !== 'number' || !Number.isFinite(yp)) continue;
    const prob = yp > 1 ? yp / 100 : yp;
    if (prob < 0 || prob > 1) continue;
    items.push({ probability: prob, weight: 1 });
    if (items.length >= 25) break;
  }
  if (items.length === 0) return null;
  return aggregateCorrelationProbability(items);
}

/**
 * Seed / 离线用：不调用 LLM，用 baseRate + 中性 news + 可选同类市场 YES 均价作 P_corr，再融合并算 edge。
 * @param {object} candidate buildModule1Candidates 的单条
 * @param {object[]} allCandidates 完整列表（用于 P_corr）
 */
export function buildSeedProbabilityEstimate(candidate, allCandidates = []) {
  const corr = inferCorrFromPeerYesPrices(candidate, allCandidates);
  const components = {
    llm: null,
    baseRate: 0.5,
    news: sentimentToProbability(0),
    corr,
  };
  const fused = fuseTrueProbability(components, { llmConfidence: 'low' });
  const edge = evaluateCheaperSideEdge({
    pTrue: fused.pTrue,
    currentPrice: candidate.currentPrice,
    side: candidate.side,
  });
  return {
    mode: 'seed_degraded',
    note: 'Seed 不调用 LLM：P_llm=null；P_base_rate=0.5；P_news=中性；P_corr 为其它 Polymarket 候选 YES 价聚合（若有）。',
    pTrue: fused.pTrue,
    pTrueRaw: fused.pTrueRaw,
    usedWeights: fused.usedWeights,
    components: fused.components,
    edge,
  };
}

/**
 * 设计文档模块 3：将 Claude 返回的 P_llm 与其它分量融合后再算 edge。
 * @param {{ probability: number, confidence: string, reasoning?: string[], uncertainty?: string }} llmParse parseLlmProbabilityJson 结果
 */
export function buildFusedProbabilityEstimateFromLlmParse(llmParse, candidate, allCandidates = []) {
  const corr = inferCorrFromPeerYesPrices(candidate, allCandidates);
  const components = {
    llm: llmParse.probability,
    baseRate: 0.5,
    news: sentimentToProbability(0),
    corr,
  };
  const fused = fuseTrueProbability(components, { llmConfidence: llmParse.confidence });
  const edge = evaluateCheaperSideEdge({
    pTrue: fused.pTrue,
    currentPrice: candidate.currentPrice,
    side: candidate.side,
  });
  return {
    mode: 'llm_fused',
    note: 'P_llm 来自 Claude JSON；P_base_rate=0.5；P_news=中性；P_corr 为其它 Polymarket 候选 YES 价聚合（若有）；再按设计权重融合并置信锚定。',
    llmExtraction: {
      reasoning: llmParse.reasoning ?? [],
      uncertainty: llmParse.uncertainty ?? '',
      confidence: llmParse.confidence,
    },
    pTrue: fused.pTrue,
    pTrueRaw: fused.pTrueRaw,
    usedWeights: fused.usedWeights,
    components: fused.components,
    edge,
  };
}

/**
 * 对模块1的 cheaper-side 输出计算 Edge。
 * side=yes  -> edge = p_true - currentPrice
 * side=no   -> edge = (1 - p_true) - currentPrice
 */
export function evaluateCheaperSideEdge({ pTrue, currentPrice, side }) {
  const p = toProbability(pTrue);
  const market = toProbability(currentPrice);
  if (p === null || market === null) throw new Error('pTrue/currentPrice invalid');
  if (side !== 'yes' && side !== 'no') throw new Error('side must be yes or no');
  const sideProb = side === 'yes' ? p : (1 - p);
  const edge = sideProb - market;
  return {
    sideProb: clamp01(sideProb),
    marketProb: market,
    edge,
    hasEdge: edge > 0,
  };
}
