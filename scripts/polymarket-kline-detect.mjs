#!/usr/bin/env node
// @ts-check
/**
 * 模块 2：对 Polymarket 快照 jsonl 做「智慧资金」K 线式检测（见 design 文档模块 2）。
 *
 * 采样流程概要（详见 docs/reports/polymarket-module2-sampling-flow.md）：
 * 1) `polymarket-us-iran-peace-snapshot.mjs` 请求 Gamma `GET /events/slug/...`，把整包事件写成一行 jsonl；
 * 2) `polymarket-us-iran-peace-watch.mjs` 或 cron 定时重复步骤 1，行数随时间增加 → 每个 marketId 的 closes/volumes 变长；
 * 3) 本脚本读取 jsonl，按 marketId 拼序列（volume 用相邻累计量的差分），再跑 5 类信号。
 *
 * Usage:
 *   node scripts/polymarket-kline-detect.mjs
 *   node scripts/polymarket-kline-detect.mjs --input path/to/file.jsonl --min-bars 120 --min-signals 2
 *   node scripts/polymarket-kline-detect.mjs --help
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  parsePolymarketSnapshotJsonl,
  detectSmartMoneyFromSnapshots,
  SMART_MONEY_DEFAULT_MIN_BARS,
} from './_polymarket-smart-money.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultInput = join(__dirname, '..', 'data', 'polymarket', 'us-iran-peace-deal-timeseries.jsonl');

function parseArgValue(name) {
  const idx = process.argv.findIndex((arg) => arg === name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function printHelp() {
  console.log(`polymarket-kline-detect — 模块2 检测（快照 jsonl）

默认输入: ${defaultInput}
默认 min-bars: ${SMART_MONEY_DEFAULT_MIN_BARS}（与价格类信号最长窗口一致）

参数:
  --input <path>       快照 jsonl 路径（或环境变量 POLYMARKET_SAMPLE_INPUT）
  --min-bars <n>       至少多少根后才跑形态检测（默认 ${SMART_MONEY_DEFAULT_MIN_BARS}）
  --min-signals <n>    触发至少需要几条子信号（默认 2）
  --help               本说明

继续采样:
  npm run polymarket:sample:us-iran-peace   # 单次追加一行
  npm run polymarket:watch:us-iran-peace    # 长轮询（默认 30 分钟间隔）

说明文档:
  docs/reports/polymarket-module2-sampling-flow.md
`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const inputPath = process.env.POLYMARKET_SAMPLE_INPUT || parseArgValue('--input') || defaultInput;
  const minBarsRaw = Number(process.env.POLYMARKET_KLINE_MIN_BARS || parseArgValue('--min-bars') || SMART_MONEY_DEFAULT_MIN_BARS);
  const minSignalsRaw = Number(process.env.POLYMARKET_KLINE_MIN_SIGNALS || parseArgValue('--min-signals') || 2);
  const minBars = Number.isFinite(minBarsRaw) && minBarsRaw > 0 ? minBarsRaw : SMART_MONEY_DEFAULT_MIN_BARS;
  const minSignals = Number.isFinite(minSignalsRaw) && minSignalsRaw > 0 ? minSignalsRaw : 2;

  const raw = await readFile(inputPath, 'utf8');
  const records = parsePolymarketSnapshotJsonl(raw);
  const detections = detectSmartMoneyFromSnapshots(records, { minBars, minSignals });

  const triggered = detections.filter((d) => d.detection.triggered);
  const ranked = [...detections].sort((a, b) => b.detection.score - a.detection.score || b.bars - a.bars);

  console.log(`[kline-detect] input=${inputPath}`);
  console.log(`[kline-detect] records=${records.length} markets=${detections.length} minBars=${minBars} minSignals=${minSignals}`);
  console.log(`[kline-detect] triggered=${triggered.length}`);
  console.log(`[kline-detect] 提示: 价格类子信号需要 closes≥120；vol_spike 需要 volumes≥65；vol_trend 需要 volumes≥60。`);

  for (const item of ranked.slice(0, 20)) {
    const signalStr = item.detection.signals.join(',') || 'none';
    console.log(`- ${item.marketId} bars=${item.bars} volBars=${item.volumeBars} score=${item.detection.score} triggered=${item.detection.triggered} signals=${signalStr} q="${item.question}"`);
    if (item.gateReason) {
      console.log(`    [gate] ${item.gateReason}`);
    }
    const shortSignals = item.insufficientBySignal.filter((r) => r.skipped);
    for (const row of shortSignals) {
      console.log(`    [${row.id}] ${row.reason}`);
    }
    if (!item.gateReason && item.detection.score === 0) {
      const allMet = item.insufficientBySignal.every((r) => !r.skipped);
      if (allMet) {
        console.log('    [形态] 各信号窗口长度已满足，但未命中阈值（非数据条数问题）');
      }
    }
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`[kline-detect] FAILED: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
