#!/usr/bin/env node
// @ts-check
/**
 * 模块 5：执行层 — 限价 GTC 下单（Polymarket CLOB v2）。
 *
 * 默认 **dry-run**（只打印将要提交的订单，不签名、不上链）。
 * 传入 `--execute` 且配置 `POLYMARKET_PRIVATE_KEY` 时才会真实下单。
 *
 * Usage:
 *   node scripts/polymarket-execute-order.mjs --market-id 123 --outcome yes --size 5 --price 0.42
 *   node scripts/polymarket-execute-order.mjs --market-id 123 --outcome yes --size 5 --price 0.42 --execute
 *   node scripts/polymarket-execute-order.mjs --help
 *
 * 环境变量见 docs/reports/polymarket-module5-execution-report.md
 */

import { pathToFileURL } from 'node:url';

import { loadEnvFile } from './_seed-utils.mjs';
import { buildUserOrderFromDecision } from './_polymarket-execution.mjs';
import { fetchGammaMarketById, pickTokenIdForOutcome } from './_polymarket-gamma-clob.mjs';
import { createPolymarketClobTradingClient, createAndPostGtcLimitOrder } from './_polymarket-clob-trading.mjs';

loadEnvFile(import.meta.url);

function parseArgValue(name) {
  const idx = process.argv.findIndex((a) => a === name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function inferMidFromGamma(market, outcome) {
  try {
    const prices = JSON.parse(market.outcomePrices || '[]');
    const idx = String(outcome).toLowerCase() === 'no' ? 1 : 0;
    const p = parseFloat(prices[idx]);
    if (Number.isFinite(p) && p > 0 && p < 1) return p;
  } catch {}
  return null;
}

function printHelp() {
  console.log(`polymarket-execute-order — 模块5 CLOB 限价单（默认 dry-run）

必选:
  --market-id <id>     Gamma 市场 id（与 seed 里 Polymarket marketId 一致）
  --size <n>           下单份额（与官方 SDK 一致）

可选:
  --outcome yes|no     交易 YES 或 NO token（默认 yes）
  --price <0-1>        参考市价概率；省略时尝试用 Gamma outcomePrices
  --clob-side BUY|SELL 对选定 token 的方向（默认 BUY）
  --slippage <n>       滑点比例，默认 0.005
  --execute            真实下单（否则仅打印计划订单）

私钥与链（仅 --execute）:
  POLYMARKET_PRIVATE_KEY 或 PRIVATE_KEY（0x 开头）
  POLYGON_RPC_URL        可选
  POLYMARKET_SIGNATURE_TYPE  0=EOA 1=Proxy 2=Gnosis（默认 0）
  POLYMARKET_FUNDER_ADDRESS  可选，默认 signer 地址

说明: 请先小额、自行承担风险；详见 docs/reports/polymarket-module5-execution-report.md
`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const marketId = parseArgValue('--market-id');
  const sizeRaw = parseArgValue('--size');
  const outcome = parseArgValue('--outcome') || 'yes';
  const priceArg = parseArgValue('--price');
  const clobSide = (parseArgValue('--clob-side') || 'BUY').toUpperCase();
  const slipRaw = parseArgValue('--slippage');
  const slippage = slipRaw == null ? 0.005 : Number(slipRaw);
  const doExecute = process.argv.includes('--execute');

  if (!marketId || !sizeRaw) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const positionSize = Number(sizeRaw);
  if (!Number.isFinite(positionSize) || positionSize <= 0) {
    console.error('[execute] invalid --size');
    process.exitCode = 1;
    return;
  }

  const market = await fetchGammaMarketById(marketId);
  const tokenId = pickTokenIdForOutcome(market, outcome);
  let marketPrice = priceArg == null ? inferMidFromGamma(market, outcome) : Number(priceArg);
  if (marketPrice == null || !Number.isFinite(marketPrice)) {
    console.error('[execute] 无法推断市价，请显式传入 --price（0~1 概率）');
    process.exitCode = 1;
    return;
  }

  const decision = {
    action: 'buy',
    token_id: tokenId,
    market_price: marketPrice,
    clobSide,
    position_size: positionSize,
    slippage_tolerance: slippage,
  };

  const built = buildUserOrderFromDecision(decision);
  if (built.skip) {
    console.error(`[execute] skip: ${built.reason}`);
    process.exitCode = 1;
    return;
  }

  const plan = {
    dryRun: !doExecute,
    marketId: String(marketId),
    question: market.question,
    outcome,
    tokenID: built.userOrder.tokenID,
    side: built.userOrder.side,
    price: built.userOrder.price,
    size: built.userOrder.size,
  };

  if (!doExecute) {
    console.log('[execute] DRY-RUN（未下单）。加 --execute 且配置私钥后才会提交 CLOB。');
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const { client, address } = await createPolymarketClobTradingClient();
  console.log(`[execute] signer/funder context address=${address}`);
  const res = await createAndPostGtcLimitOrder(client, built.userOrder);
  console.log('[execute] submitted');
  console.log(JSON.stringify({ plan, response: res }, null, 2));
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`[execute] FAILED: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
