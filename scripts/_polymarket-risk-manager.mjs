/**
 * 模块 6：风险控制层（设计稿 `RiskManager.monitor_positions` 对齐的纯函数）。
 * 输入持仓 + 当前市价（0~1），输出 hold / close 及原因。
 */

/** 与设计稿一致的默认规则（可按环境或 JSON 覆盖） */
export const DEFAULT_RISK_RULES = {
  stop_loss_pct: 0.4,
  take_profit_pct: 0.6,
  trailing_stop_pct: 0.15,
  /** 盈利达到该比例后启用移动止损（设计稿硬编码 0.20） */
  trailing_arm_pct: 0.2,
  min_days_to_hold: 1,
  force_close_days: 1,
};

/**
 * @typedef {object} RiskPositionInput
 * @property {string} tokenId CLOB outcome token id
 * @property {number} entryPrice01 建仓参考价 (0,1)
 * @property {number} [peakPrice01] 历史最高价（缺省用 entry）
 * @property {number} [daysToExpiry] 距离到期天数（缺省视为无穷大，不触发到期平仓）
 * @property {number} [heldDays] 已持有天数（用于 min_days_to_hold）
 */

/**
 * @param {RiskPositionInput} position
 * @param {number} currentPrice01 当前市价 (0,1)
 * @param {Partial<typeof DEFAULT_RISK_RULES>} [rules]
 * @returns {{
 *   action: 'hold'|'close',
 *   reason: string,
 *   pnlPct?: number,
 *   effectivePeak01?: number,
 *   drawdownPct?: number,
 * }}
 */
export function evaluatePositionRisk(position, currentPrice01, rules = {}) {
  const r = { ...DEFAULT_RISK_RULES, ...rules };
  const entry = Number(position?.entryPrice01);
  const cur = Number(currentPrice01);
  if (!Number.isFinite(entry) || entry <= 0 || entry >= 1) {
    return { action: 'hold', reason: 'invalid_entry_price' };
  }
  if (!Number.isFinite(cur) || cur <= 0 || cur >= 1) {
    return { action: 'hold', reason: 'invalid_current_price' };
  }

  const heldDays = Number(position?.heldDays ?? 0);
  const daysToExpiry = position?.daysToExpiry;
  const dte = Number(daysToExpiry);

  if (Number.isFinite(dte) && dte <= r.force_close_days) {
    return {
      action: 'close',
      reason: 'near_expiry',
      pnlPct: (cur - entry) / entry,
      effectivePeak01: Math.max(Number(position?.peakPrice01 ?? entry), cur),
    };
  }

  const pnlPct = (cur - entry) / entry;
  const effectivePeak01 = Math.max(Number(position?.peakPrice01 ?? entry), cur);
  const canDiscretionary = Number.isFinite(heldDays) && heldDays >= r.min_days_to_hold;

  if (canDiscretionary && pnlPct <= -r.stop_loss_pct) {
    return { action: 'close', reason: 'stop_loss', pnlPct, effectivePeak01 };
  }

  if (canDiscretionary && pnlPct + 1e-9 >= r.trailing_arm_pct) {
    const drawdownPct = (effectivePeak01 - cur) / effectivePeak01;
    if (Number.isFinite(drawdownPct) && drawdownPct >= r.trailing_stop_pct) {
      return {
        action: 'close',
        reason: 'trailing_stop',
        pnlPct,
        effectivePeak01,
        drawdownPct,
      };
    }
  }

  if (canDiscretionary && pnlPct >= r.take_profit_pct) {
    return { action: 'close', reason: 'take_profit', pnlPct, effectivePeak01 };
  }

  if (!canDiscretionary && (pnlPct <= -r.stop_loss_pct || pnlPct >= r.take_profit_pct)) {
    return {
      action: 'hold',
      reason: 'min_hold_days_not_met',
      pnlPct,
      effectivePeak01,
    };
  }

  return { action: 'hold', reason: 'within_risk_bands', pnlPct, effectivePeak01 };
}

/**
 * @param {RiskPositionInput[]} positions
 * @param {Record<string, number|null|undefined>} priceByTokenId tokenId -> 当前价；缺失视为无法评估（hold）
 * @param {Partial<typeof DEFAULT_RISK_RULES>} [rules]
 */
export function monitorPositions(positions, priceByTokenId, rules = {}) {
  if (!Array.isArray(positions)) return [];
  return positions.map((pos) => {
    const tokenId = String(pos?.tokenId || '');
    const mid = priceByTokenId[tokenId];
    const current = mid == null ? NaN : Number(mid);
    if (!tokenId) {
      return { tokenId: '', action: 'hold', reason: 'missing_token_id', detail: null };
    }
    if (!Number.isFinite(current)) {
      return { tokenId, action: 'hold', reason: 'missing_or_invalid_mid', detail: null };
    }
    const detail = evaluatePositionRisk(pos, current, rules);
    return { tokenId, ...detail };
  });
}
