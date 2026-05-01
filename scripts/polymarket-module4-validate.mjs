#!/usr/bin/env node
// @ts-check
/**
 * 模块 4：多 Agent 验证（Bull / Bear / 风险裁判）+ Kelly 头寸建议。
 *
 * 设计见：`Polymarket-Agent交易系统设计(2).md` 模块 4。
 *
 * 运行（离线 stub，默认，无需 API）:
 *   node scripts/polymarket-module4-validate.mjs --demo
 *   node scripts/polymarket-module4-validate.mjs --input path/to/case.json --stub
 *
 * 运行（真实 LLM，需 ANTHROPIC_API_KEY）:
 *   export ANTHROPIC_API_KEY=...
 *   node scripts/polymarket-module4-validate.mjs --input path/to/case.json --llm
 *
 * 单测:
 *   node --test tests/polymarket-module4-multi-agent.test.mjs
 *
 * 输入 JSON 字段示例:
 *   { "title":"...", "description":"", "endDate":"", "side":"yes"|"no",
 *     "currentPrice":0.44, "pTrue":0.56,
 *     "smartMoney":{ "triggered":true, "score":2, "signals":["slow_grind"] },
 *     "liquidity":12345, "volume24h":9999 }
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createAnthropicCallLlm } from './_polymarket-anthropic.mjs';
import { loadEnvFile } from './_seed-utils.mjs';
import {
  stubModule4Decision,
  runModule4LlmPipeline,
} from './_polymarket-multi-agent.mjs';

loadEnvFile(import.meta.url);

const DEMO_CASE = {
  title: '示例：某二元事件',
  description: '用于演示模块4流水线；请换成真实候选 + 模块2/3 输出。',
  endDate: '2026-12-31',
  side: 'yes',
  currentPrice: 0.44,
  pTrue: 0.56,
  smartMoney: { triggered: true, score: 2, signals: ['slow_grind', 'vol_trend'] },
  liquidity: 50_000,
  volume24h: 12_000,
};

function parseArgValue(name) {
  const idx = process.argv.findIndex((arg) => arg === name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function printHelp() {
  console.log(`polymarket-module4-validate — 模块4 多 Agent 验证

用法:
  node scripts/polymarket-module4-validate.mjs --demo [--bankroll 10000]
  node scripts/polymarket-module4-validate.mjs --input <case.json> --stub
  node scripts/polymarket-module4-validate.mjs --input <case.json> --llm

参数:
  --demo              使用内置示例输入（stub）；若同时提供 --input，则以 --input 为准
  --input <path>      候选 JSON（含 title, side, currentPrice, pTrue, smartMoney 等）
  --stub              确定性裁判（默认，与未指定 --llm 时相同）
  --llm               调用 Anthropic API（需 ANTHROPIC_API_KEY）
  --bankroll <n>      资金假设（默认 10000）
  --help              本说明

环境变量:
  ANTHROPIC_API_KEY   使用 --llm 时必填
  ANTHROPIC_MODEL     可选，默认 claude-3-5-haiku-20241022

测试:
  node --test tests/polymarket-module4-multi-agent.test.mjs
`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const useLlm = process.argv.includes('--llm');
  const useDemo = process.argv.includes('--demo');
  const inputPath = parseArgValue('--input');
  const bankrollRaw = Number(parseArgValue('--bankroll') || process.env.POLYMARKET_MODULE4_BANKROLL || 10_000);
  const bankroll = Number.isFinite(bankrollRaw) && bankrollRaw > 0 ? bankrollRaw : 10_000;

  let input;
  if (inputPath) {
    const raw = await readFile(resolve(process.cwd(), inputPath), 'utf8');
    input = JSON.parse(raw);
  } else if (useDemo) {
    input = { ...DEMO_CASE };
  } else {
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (useLlm) {
    const callLlm = await createAnthropicCallLlm();
    const out = await runModule4LlmPipeline(input, callLlm, { bankroll });
    console.log(JSON.stringify(out, null, 2));
  } else {
    const out = stubModule4Decision(input, { bankroll });
    console.log(JSON.stringify(out, null, 2));
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`[module4] FAILED: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
