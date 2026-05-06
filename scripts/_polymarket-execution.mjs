/**
 * 模块 5：执行层 — 与设计稿 `ExecutionEngine` 对齐的纯逻辑 + 调用 CLOB 的输入准备。
 * 真实链上签名与 POST 由 `polymarket-execute-order.mjs` / `createPolymarketClobTradingClient` 完成。
 */

/**
 * 在二元概率价 [0,1] 上按滑点调整限价（设计稿：市价基础上微调）。
 * - BUY：略抬高限价，便于吃单（上限 0.999）
 * - SELL：略压低限价（下限 0.001）
 * @param {'BUY'|'SELL'} side CLOB 侧
 */
export function calculateLimitPriceProbability(marketPrice, side, slippageTolerance = 0.005) {
  const p = Number(marketPrice);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) {
    throw new Error('marketPrice must be a finite number in (0,1)');
  }
  const t = Number(slippageTolerance);
  const tol = Number.isFinite(t) && t >= 0 && t < 0.5 ? t : 0.005;
  if (side === 'BUY') return Math.min(0.999, p * (1 + tol));
  if (side === 'SELL') return Math.max(0.001, p * (1 - tol));
  throw new Error('side must be BUY or SELL');
}

/**
 * @param {object} decision
 * @param {string} decision.action buy | skip | short（与模块4 judge 一致；short 表示押对侧腿，需调用方选对 token）
 * @param {string} [decision.token_id] CLOB token id
 * @param {number} decision.market_price 市价概率 (0,1)
 * @param {'BUY'|'SELL'} decision.clobSide 对选定 token 的买卖方向
 * @param {number} decision.position_size 份额（与 Polymarket SDK 一致）
 * @param {number} [decision.slippage_tolerance]
 */
export function buildUserOrderFromDecision(decision) {
  const action = String(decision?.action || 'skip').toLowerCase();
  if (action === 'skip') {
    return { skip: true, reason: 'no_edge' };
  }
  const tokenId = decision.token_id;
  if (!tokenId) {
    return { skip: true, reason: 'missing_token_id' };
  }
  const side = decision.clobSide === 'SELL' ? 'SELL' : 'BUY';
  const price = calculateLimitPriceProbability(
    decision.market_price,
    side,
    decision.slippage_tolerance ?? 0.005,
  );
  const size = Number(decision.position_size);
  if (!Number.isFinite(size) || size <= 0) {
    return { skip: true, reason: 'invalid_position_size' };
  }
  return {
    skip: false,
    userOrder: {
      tokenID: String(tokenId),
      price,
      size,
      side,
    },
  };
}
