#!/usr/bin/env node
// @ts-check
/**
 * 模块 6：平仓执行 — 读持仓账本 → 风控评估 → 对 action=close 的腿组 SELL 限价（默认 dry-run）。
 *
 *   node scripts/polymarket-risk-close.mjs
 *   node scripts/polymarket-risk-close.mjs --execute
 *
 * 环境: 同模块5 — POLYMARKET_PRIVATE_KEY；账本路径 POLYMARKET_POSITIONS_LEDGER_PATH 或默认 data/polymarket/open-positions.json
 */

import { pathToFileURL } from 'node:url';

import { loadEnvFile } from './_seed-utils.mjs';
import { fetchClobMidpoints } from './_polymarket-clob-price.mjs';
import { DEFAULT_RISK_RULES, monitorPositions } from './_polymarket-risk-manager.mjs';
import {
  readLedgerFile,
  resolveLedgerPath,
  normalizePositionsForRisk,
  removeOpenPositionByTokenId,
} from './_polymarket-positions-ledger.mjs';
import { buildUserOrderFromDecision } from './_polymarket-execution.mjs';
import { createPolymarketClobTradingClient, createAndPostGtcLimitOrder } from './_polymarket-clob-trading.mjs';

loadEnvFile(import.meta.url);

function parseArgValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function printHelp() {
  console.log(`polymarket-risk-close — 模块6 平仓（默认 dry-run）

用法:
  node scripts/polymarket-risk-close.mjs
  node scripts/polymarket-risk-close.mjs --execute

参数:
  --ledger <path>       默认 env POLYMARKET_POSITIONS_LEDGER_PATH 或 data/polymarket/open-positions.json
  --rules-json <path>   覆盖风控规则 JSON
  --slippage <n>        SELL 限价滑点，默认 0.005
  --execute             真实提交 SELL；否则只打印计划
  --remove-on-success   --execute 且订单提交返回后，从账本移除该 tokenId（默认开启；传 --no-remove 关闭）
  --help

安全: 默认 dry-run；真卖单前务必先 npm run polymarket:risk-monitor 核对 close 原因。
`);
}

async function loadRules() {
  let rules = { ...DEFAULT_RISK_RULES };
  const rulesPath = parseArgValue('--rules-json');
  if (rulesPath) {
    const { readFile } = await import('node:fs/promises');
    const extra = JSON.parse(await readFile(rulesPath, 'utf8'));
    rules = { ...DEFAULT_RISK_RULES, ...extra };
  }
  return rules;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const ledgerPath = parseArgValue('--ledger') || resolveLedgerPath();
  const doExecute = process.argv.includes('--execute');
  const removeOnSuccess = !process.argv.includes('--no-remove');
  const slipRaw = parseArgValue('--slippage');
  const slippage = slipRaw == null ? 0.005 : Number(slipRaw);

  const rawRows = await readLedgerFile(ledgerPath);
  if (rawRows.length === 0) {
    console.log(JSON.stringify({ ledgerPath, message: 'ledger empty or missing', closes: [] }, null, 2));
    return;
  }

  const rules = await loadRules();
  const forRisk = normalizePositionsForRisk(rawRows);
  const ids = forRisk.map((p) => String(p?.tokenId || '')).filter(Boolean);
  const mids = await fetchClobMidpoints(ids);
  const results = monitorPositions(forRisk, mids, rules);

  /** @type {object[]} */
  const closes = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.action !== 'close') continue;
    const row = rawRows.find((x) => String(x?.tokenId) === r.tokenId);
    const shares = row?.shares == null ? NaN : Number(row.shares);
    const mid = mids[r.tokenId];
    if (!Number.isFinite(shares) || shares <= 0 || mid == null || !Number.isFinite(Number(mid))) {
      closes.push({
        tokenId: r.tokenId,
        reason: r.reason,
        skip: true,
        skipWhy: 'missing_shares_or_mid',
      });
      continue;
    }
    const built = buildUserOrderFromDecision({
      action: 'close',
      token_id: r.tokenId,
      market_price: Number(mid),
      clobSide: 'SELL',
      position_size: shares,
      slippage_tolerance: slippage,
    });
    closes.push({
      tokenId: r.tokenId,
      riskReason: r.reason,
      pnlPct: r.pnlPct,
      plan: built.skip ? null : built.userOrder,
      skip: built.skip,
      skipReason: built.skip ? built.reason : undefined,
    });
  }

  const out = { dryRun: !doExecute, ledgerPath, closes };
  if (!doExecute) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const { client, address } = await createPolymarketClobTradingClient();
  console.log(`[risk-close] execute signer=${address}`);
  const submitted = [];
  for (const c of closes) {
    if (c.skip || !c.plan) {
      submitted.push({ ...c, submitted: false });
      continue;
    }
    try {
      const res = await createAndPostGtcLimitOrder(client, c.plan);
      submitted.push({ ...c, submitted: true, response: res });
      if (removeOnSuccess && c.tokenId) {
        await removeOpenPositionByTokenId(ledgerPath, c.tokenId);
      }
    } catch (err) {
      submitted.push({
        ...c,
        submitted: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  console.log(JSON.stringify({ ...out, submitted }, null, 2));
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`[risk-close] FAILED: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
