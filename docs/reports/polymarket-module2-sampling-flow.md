# Polymarket 模块 2：快照采样与 K 线检测流程

## 1. 数据从哪来

- **入口脚本**：[`scripts/polymarket-us-iran-peace-snapshot.mjs`](../../scripts/polymarket-us-iran-peace-snapshot.mjs)
- **HTTP**：`GET https://gamma-api.polymarket.com/events/slug/us-x-iran-permanent-peace-deal-by`
- **输出**：每执行一次，向 jsonl **追加一行** JSON（不是覆盖整个文件）。

默认输出路径：

- `data/polymarket/us-iran-peace-deal-timeseries.jsonl`  
  或通过环境变量 `POLYMARKET_SAMPLE_OUTPUT` 指定。

## 2. 「一行」里是什么

每一行是一个完整快照对象，包含：

- `sampledAt` / `sampledAtIso`：采样时间
- `markets[]`：该事件下多个二元市场的当前字段（含 `marketId`、`pYes`、`volume` 累计量、`liquidity` 等）

因此：**行数 = 对该事件执行快照的次数**，不是交易所固定周期 K 线。

## 3. 如何持续采样

**单次（手动或 cron）：**

- `node scripts/polymarket-us-iran-peace-snapshot.mjs`  
  或 `npm run polymarket:sample:us-iran-peace`（若 `package.json` 已配置）

**长驻轮询：**

- `node scripts/polymarket-us-iran-peace-watch.mjs`  
  或 `npm run polymarket:watch:us-iran-peace`
- 间隔由 `POLYMARKET_SAMPLE_INTERVAL_MIN` 控制（默认 30 分钟）。

**快速补满行数（例如凑够模块 2 默认 120 根）：**

- `node scripts/polymarket-us-iran-peace-snapshot-burst.mjs --target 120 --delay-ms 350`  
  或 `npm run polymarket:burst:us-iran-peace`（默认目标 120，可用环境变量 `BURST_TARGET_LINES` / `BURST_DELAY_MS` 覆盖）  
- 注意：会向 Gamma 连续请求多次，请自行控制频率，避免触发上游限流。

每多一行，每个 `marketId` 就多一个时间点 → 模块 2 里该市场的 **closes / volumes 序列长度 +1**。

## 4. 模块 2 如何把快照变成「K 线」

脚本：[`scripts/_polymarket-smart-money.mjs`](../../scripts/_polymarket-smart-money.mjs)

- **收盘价序列 `closes`**：`pYes`（若无则用 `lastTradePrice`），范围按 0–1 处理。
- **成交量序列 `volumes`**：对 Gamma 返回的 **累计** `volume` 做相邻差分，得到「这一段时间内的增量」，第一根为 `0`。

## 5. 为什么默认 `minBars = 120`

设计里多条规则依赖固定窗口，例如：

- `slow_grind` / `narrow_pullback` / `breakout`：需要 **120** 根 `closes`（`breakout` 同时用到 60 与 120，以 120 为准）。
- `vol_trend`：需要 **60** 根 `volumes`。
- `vol_spike`：需要 **65** 根 `volumes`（前 60 基准 + 后 5）。

默认运行门槛取 **120**，与最长价格窗口对齐，避免「已跑检测但价格类信号永远为 false」的误导。

## 6. 如何跑检测 CLI

```bash
node scripts/polymarket-kline-detect.mjs
node scripts/polymarket-kline-detect.mjs --input data/polymarket/us-iran-peace-deal-timeseries.jsonl
node scripts/polymarket-kline-detect.mjs --help
```

当某条子信号因 **数据点不够** 不可能触发时，CLI 会按信号打印 `数据不足：...` 说明。

## 7. 单测

```bash
node --test tests/polymarket-smart-money-detector.test.mjs
```
