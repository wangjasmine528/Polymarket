#!/usr/bin/env node
// @ts-check
/**
 * Phase C — Read Phase B alignment JSONL and emit aggregate metrics (MAE, RMSE, direction vs market deltas).
 *
 *   npm run sim:oasis:polymarket-c -- --pretty
 *   npm run sim:oasis:polymarket-c -- --alignment ./data/polymarket/us-iran-oasis-b-alignment.jsonl --last 50
 *   npm run sim:oasis:polymarket-c -- --write-report
 *
 * Env:
 *   OASIS_B_ALIGNMENT_INPUT   default: data/polymarket/us-iran-oasis-b-alignment.jsonl (under repo root)
 */

import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { appendFile, mkdir } from 'node:fs/promises';

import { loadEnvFile } from './_seed-utils.mjs';
import { computePhaseCMetrics } from './oasis-sim/phase-c-metrics.mjs';

loadEnvFile(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_ALIGNMENT = join(__dirname, '..', 'data', 'polymarket', 'us-iran-oasis-b-alignment.jsonl');
const DEFAULT_REPORT_PATH = join(__dirname, '..', 'data', 'polymarket', 'us-iran-oasis-c-reports.jsonl');

/**
 * @param {string} line
 * @returns {import('./oasis-sim/phase-c-metrics.mjs').AlignmentPoint | null}
 */
function parseAlignmentLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    /** @type {any} */
    const row = JSON.parse(trimmed);
    if (row.kind !== 'oasis_b_polymarket_alignment') return null;
    const pHat = row?.oasis?.pHat;
    const pMarketYes = row?.polymarket?.pMarketYes;
    const slug = row?.polymarket?.marketSlug != null ? String(row.polymarket.marketSlug) : '';
    const sampledAt = Number(row.sampledAt);
    if (!Number.isFinite(sampledAt) || !Number.isFinite(pHat) || !Number.isFinite(pMarketYes)) return null;
    return { sampledAt, pHat, pMarketYes, marketSlug: slug };
  } catch {
    return null;
  }
}

/**
 * @param {string} filePath
 * @param {number | null} lastN
 * @returns {Promise<import('./oasis-sim/phase-c-metrics.mjs').AlignmentPoint[]>}
 */
async function loadAlignmentPoints(filePath, lastN) {
  /** @type {import('./oasis-sim/phase-c-metrics.mjs').AlignmentPoint[]} */
  const all = [];
  try {
    await readFile(filePath, { flag: 'r' });
  } catch {
    return [];
  }

  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const p = parseAlignmentLine(line);
    if (p) all.push(p);
  }

  all.sort((a, b) => a.sampledAt - b.sampledAt);
  if (lastN != null && lastN > 0 && all.length > lastN) {
    return all.slice(-lastN);
  }
  return all;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const inputPath = args.alignmentPath || process.env.OASIS_B_ALIGNMENT_INPUT?.trim() || DEFAULT_ALIGNMENT;
  const points = await loadAlignmentPoints(inputPath, args.lastN);
  const metrics = computePhaseCMetrics(points);

  const evaluatedAt = Date.now();
  const report = {
    kind: 'oasis_c_eval_report',
    evaluatedAt,
    evaluatedAtIso: new Date(evaluatedAt).toISOString(),
    inputPath,
    lastN: args.lastN,
    nRowsRead: points.length,
    metrics,
    marketSlug: points.length > 0 ? points[points.length - 1].marketSlug : '',
  };

  if (args.writeReport) {
    await mkdir(dirname(DEFAULT_REPORT_PATH), { recursive: true });
    await appendFile(DEFAULT_REPORT_PATH, `${JSON.stringify(report)}\n`, 'utf8');
    console.log(`[oasis-c] appended report → ${DEFAULT_REPORT_PATH}`);
  }

  if (args.pretty) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(JSON.stringify(report));
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {{ alignmentPath: string; lastN: number | null; pretty: boolean; writeReport: boolean; help: boolean }} */
  const args = {
    alignmentPath: '',
    lastN: null,
    pretty: false,
    writeReport: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--alignment' && argv[i + 1]) args.alignmentPath = argv[++i];
    else if (t === '--last' && argv[i + 1]) args.lastN = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (t === '--pretty') args.pretty = true;
    else if (t === '--write-report') args.writeReport = true;
    else if (t === '--help' || t === '-h') args.help = true;
    else throw new Error(`Unknown arg: ${t}`);
  }
  return args;
}

function printUsage() {
  console.log(
    [
      'Usage: node scripts/run-oasis-polymarket-c-eval.mjs [options]',
      '',
      'Reads Phase B JSONL (oasis_b_polymarket_alignment) and prints MAE / RMSE / direction match vs market.',
      '',
      'Options:',
      '  --alignment <path>   alignment JSONL (default: data/polymarket/us-iran-oasis-b-alignment.jsonl)',
      '  --last <n>           use only last n valid rows (after sort by time)',
      '  --write-report       append this report to data/polymarket/us-iran-oasis-c-reports.jsonl',
      '  --pretty',
      '  --help',
      '',
      'Env: OASIS_B_ALIGNMENT_INPUT overrides default alignment path',
    ].join('\n'),
  );
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`[oasis-c] FAILED: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}

export { main, loadAlignmentPoints, parseAlignmentLine };
