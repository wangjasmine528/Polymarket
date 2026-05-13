/**
 * 持仓账本：本地 JSON 数组（默认 data/polymarket/open-positions.json，gitignore）。
 * 供模块 6 risk-monitor / risk-close 读取；由 auto-exec --execute 成功后追加。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __ledgerDir = dirname(fileURLToPath(import.meta.url));

/** @returns {string} 默认账本路径（仓库根 data/polymarket/open-positions.json） */
export function defaultLedgerPath() {
  return join(__ledgerDir, '..', 'data', 'polymarket', 'open-positions.json');
}

export function resolveLedgerPath() {
  const p = String(process.env.POLYMARKET_POSITIONS_LEDGER_PATH || '').trim();
  return p || defaultLedgerPath();
}

/**
 * @param {string|undefined} endDate ISO 或 Gamma 日期字符串
 * @param {number} [nowMs]
 * @returns {number|null} 距离到期天数，无法解析则 null
 */
export function daysToExpiryFromEndDate(endDate, nowMs = Date.now()) {
  if (!endDate) return null;
  const ms = Date.parse(String(endDate));
  if (!Number.isFinite(ms)) return null;
  return (ms - nowMs) / 86_400_000;
}

/**
 * 从 openedAtMs 推导 heldDays（向下取整天）。
 * @param {object} row
 */
export function deriveHeldDays(row, nowMs = Date.now()) {
  if (row?.heldDays != null && Number.isFinite(Number(row.heldDays))) return Number(row.heldDays);
  const opened = Number(row?.openedAtMs);
  if (!Number.isFinite(opened) || opened <= 0) return 0;
  return Math.max(0, Math.floor((nowMs - opened) / 86_400_000));
}

/**
 * @param {object[]} rows
 * @returns {object[]} 供 risk-manager 使用的行（补 heldDays）
 */
export function normalizePositionsForRisk(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const heldDays = deriveHeldDays(r);
    const { shares, openedAtMs, source, orderSummary, id, marketId, outcome, title, ...rest } = r;
    return {
      ...rest,
      id,
      marketId,
      outcome,
      title,
      tokenId: r.tokenId,
      entryPrice01: Number(r.entryPrice01),
      peakPrice01: r.peakPrice01 != null ? Number(r.peakPrice01) : undefined,
      daysToExpiry: r.daysToExpiry != null ? Number(r.daysToExpiry) : undefined,
      heldDays,
      _ledgerMeta: { shares, openedAtMs, source, orderSummary },
    };
  });
}

/**
 * 同 tokenId 仅保留一条「当前未平」记录：新成交覆盖旧 open（简化单腿账本）。
 * @param {object[]} existing
 * @param {object} entry 必须含 tokenId, entryPrice01, shares, openedAtMs
 */
export function upsertOpenPosition(existing, entry) {
  const list = Array.isArray(existing) ? [...existing] : [];
  const tid = String(entry.tokenId || '');
  if (!tid) return list;
  const filtered = list.filter((r) => String(r?.tokenId) !== tid);
  const row = {
    id: entry.id || randomUUID(),
    tokenId: tid,
    entryPrice01: Number(entry.entryPrice01),
    peakPrice01: entry.peakPrice01 != null ? Number(entry.peakPrice01) : Number(entry.entryPrice01),
    shares: Number(entry.shares),
    marketId: entry.marketId != null ? String(entry.marketId) : '',
    outcome: entry.outcome != null ? String(entry.outcome) : '',
    title: entry.title != null ? String(entry.title) : '',
    openedAtMs: Number(entry.openedAtMs) || Date.now(),
    daysToExpiry: entry.daysToExpiry == null ? null : Number(entry.daysToExpiry),
    heldDays: 0,
    source: entry.source || 'ledger',
    orderSummary: entry.orderSummary && typeof entry.orderSummary === 'object' ? entry.orderSummary : undefined,
  };
  if (!Number.isFinite(row.entryPrice01) || row.entryPrice01 <= 0 || row.entryPrice01 >= 1) return filtered;
  if (!Number.isFinite(row.shares) || row.shares <= 0) return filtered;
  filtered.push(row);
  return filtered;
}

export async function readLedgerFile(path) {
  try {
    const raw = await readFile(path, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function writeLedgerFile(path, rows) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  await writeFile(path, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
}

/**
 * @param {string} path
 * @param {object} entry 见 upsertOpenPosition
 */
export async function appendOpenPosition(path, entry) {
  const cur = await readLedgerFile(path);
  const next = upsertOpenPosition(cur, entry);
  await writeLedgerFile(path, next);
  return next.length;
}

/**
 * 按 tokenId 移除一条（名义平仓后记账用）。
 * @param {string} path
 * @param {string} tokenId
 */
export async function removeOpenPositionByTokenId(path, tokenId) {
  const tid = String(tokenId || '');
  const cur = await readLedgerFile(path);
  const next = cur.filter((r) => String(r?.tokenId) !== tid);
  await writeLedgerFile(path, next);
  return { removed: cur.length - next.length, remaining: next.length };
}
