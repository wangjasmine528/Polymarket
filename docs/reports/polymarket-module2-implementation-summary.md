# Polymarket Agent：模块 1 之后 — 模块 2（K 线异常检测 / 资金信号层）工作总结

**状态：** 实现与本地验证完成（设计对齐 + 工程可运行）  
**日期：** 2026-04-23  

本文档承接 [模块 1 实现报告](module1-market-scan-report.md)，总结**模块 1 落地之后**为**模块 2**所做的全部工作：设计对齐、核心算法、数据采样链路、快速补数、CLI 与单测、以及「数据量足够后」的典型运行结果说明。

---

## 1. 设计目标（对照 `Polymarket-Agent交易系统设计(2).md`）

模块 2 核心思想：**不预测事件，追踪智慧资金在价格与成交量上留下的痕迹**。

设计文档中的五类信号（节选）：

1. **缓慢爬升** — 约 120 根内总涨幅 >5%，单根最大相对波动 <1.5%  
2. **成交量线性增长** — 近 60 根 volume 线性回归斜率 >0 且 R² >0.5  
3. **回调收窄** — 近半段最大回撤相对前半段收窄（< 早期的 60%）  
4. **横盘突破** — MA60 与 MA120 偏差 <2%，且当前价相对 MA60 突破约 3%  
5. **成交量突增** — 近 5 根均量 > 过去 60 根基准均量的 2.5 倍  

**聚合规则：** 任意 **≥2** 类子信号同时成立 → `triggered=true`。

---

## 2. 代码实现清单

| 文件 | 作用 |
|------|------|
| [`scripts/_polymarket-smart-money.mjs`](../../scripts/_polymarket-smart-money.mjs) | 五类检测 + `detectSmartMoneySignals`；从 Gamma 快照 jsonl 拼 `closes`/`volumes`；`explainSmartMoneyInsufficientData`（数据不足说明）；默认 `minBars=120`（`SMART_MONEY_DEFAULT_MIN_BARS`）。 |
| [`scripts/polymarket-kline-detect.mjs`](../../scripts/polymarket-kline-detect.mjs) | CLI：读 jsonl → 输出每市场检测结果、`[gate]` 与逐信号「数据不足」行、`--help`。 |
| [`scripts/polymarket-us-iran-peace-snapshot-burst.mjs`](../../scripts/polymarket-us-iran-peace-snapshot-burst.mjs) | 连续调用单次采样，快速把 jsonl 行数补到目标（如 120）。 |
| [`tests/polymarket-smart-money-detector.test.mjs`](../../tests/polymarket-smart-money-detector.test.mjs) | 单测：回归五类信号、聚合、jsonl 解析、volume 差分、`explainSmartMoneyInsufficientData`。 |
| [`package.json`](../../package.json) | 新增 `polymarket:burst:us-iran-peace`。 |
| [`docs/reports/polymarket-module2-sampling-flow.md`](polymarket-module2-sampling-flow.md) | 采样与检测流程说明（含 burst）。 |

**与模块 1 的关系：** 模块 1 在 `seed-prediction-markets` 中产出 `candidates` 等粗筛结果；模块 2 当前实现为**独立脚本链路**（基于事件级时间序列快照），尚未写入同一 Redis seed 载荷——便于先验证算法与数据质量，后续可按产品需要接线。

---

## 3. 数据从哪里来（采样流程）

### 3.1 单次采样（一行 = 一次全事件快照）

- 脚本：[`scripts/polymarket-us-iran-peace-snapshot.mjs`](../../scripts/polymarket-us-iran-peace-snapshot.mjs)  
- 请求：`GET https://gamma-api.polymarket.com/events/slug/us-x-iran-permanent-peace-deal-by`  
- 输出：向 jsonl **追加一行** JSON；默认路径  
  `data/polymarket/us-iran-peace-deal-timeseries.jsonl`  
  （可用 `POLYMARKET_SAMPLE_OUTPUT` 覆盖）。

### 3.2 长周期采样

- 脚本：[`scripts/polymarket-us-iran-peace-watch.mjs`](../../scripts/polymarket-us-iran-peace-watch.mjs)  
- npm：`npm run polymarket:watch:us-iran-peace`  
- 间隔：`POLYMARKET_SAMPLE_INTERVAL_MIN`（默认 30 分钟）。

### 3.3 快速补满行数（研发 / 凑窗口）

- 脚本：`scripts/polymarket-us-iran-peace-snapshot-burst.mjs`  
- npm：`npm run polymarket:burst:us-iran-peace`  
- 行为：循环调用 `runPolymarketUsIranPeaceSnapshot()`，直到行数 ≥ `BURST_TARGET_LINES`（默认 120）；两次请求之间 `BURST_DELAY_MS`（默认 400ms）以降低限流风险。

**说明：** 这不是「交易所 1 分钟 K」，而是**按采样时刻排列的离散序列**；窗口里的「120」表示 **120 次成功快照**，时间跨度取决于采样间隔。

### 3.4 模块 2 如何把快照变成序列

在 `_polymarket-smart-money.mjs` 中：

- **`closes`**：`pYes`（若无则用 `lastTradePrice`），按 0–1 概率处理。  
- **`volumes`**：对 API 返回的**累计** `volume` 做相邻差分，得到增量；首点增量为 `0`。

---

## 4. 默认 `minBars = 120` 的原因

各子检测对长度有**硬下限**（与实现对齐）：

- 价格类多条规则依赖 **120** 根 `closes`（如 `slow_grind`、`narrow_pullback`、`breakout` 的 MA120）。  
- `vol_trend` 需要 **60** 根 `volumes`。  
- `vol_spike` 需要 **65** 根 `volumes`（60 基准 + 5 近期）。

因此将「是否运行形态检测」的默认门槛设为 **120**，与最长价格窗口一致，避免「已跑检测但价格类子信号永远因长度不足为 false」的误导。

当长度不足时，`polymarket-kline-detect.mjs` 会打印：

- `[gate] ... minBars=...`  
- 以及每条子信号的 **`[signalId] 数据不足：...`**

当长度已满足但 **没有任何子信号命中** 时，打印：

- `[形态] 各信号窗口长度已满足，但未命中阈值（非数据条数问题）`

---

## 5. 测试与运行命令

**单测：**

```bash
node --test tests/polymarket-smart-money-detector.test.mjs
```

**检测 CLI（默认读仓库内 jsonl）：**

```bash
node scripts/polymarket-kline-detect.mjs
node scripts/polymarket-kline-detect.mjs --help
```

**补采样到 120 行（示例）：**

```bash
npm run polymarket:burst:us-iran-peace
# 或
node scripts/polymarket-us-iran-peace-snapshot-burst.mjs --target 120 --delay-ms 350
```

---

## 6. 「数据量够之后」的典型结果（你提供的终端片段）

在 `records` 与主市场 `bars` 均已 **≥120**（例如 `bars=146`）时：

- **`[gate]` 不再出现** — 已通过运行门槛，执行了完整五类检测。  
- **`triggered=0`、`score=0`、`signals=none`** — 表示在当前这段真实行情下，**没有任何一类子信号满足设计阈值**；同时 CLI 会打出 **`[形态] 各信号窗口长度已满足...`**，说明当前是**形态未触发**，而不是数据条数不够。  
- **较晚出现的市场**（如某 `marketId` 只在后面若干快照里才出现）可能 `bars` 仍略少于 120，会继续看到 `[gate]` 与部分子信号的「数据不足」— 属于预期，需要更多快照或单独接受该市场晚参与。

这与「模块 2 在找异常资金行为」一致：**大部分时间本就不该触发**；若长期随机触发，反而要怀疑阈值过松或过拟合。

---

## 7. 后续可接工作（未在本轮强制完成）

1. **与模块 1 输出接线**：对 `candidates` 中每个市场拉/存时间序列，在 seed 或独立 job 中写入 `smartMoney` 字段。  
2. **多事件通用化**：当前采样脚本写死 `us-x-iran-permanent-peace-deal-by`；可参数化 `eventSlug` 与输出路径。  
3. **观测与调参**：统计各信号触发率、与后续模块 3/4 的命中率联动再调阈值。  
4. **合规与频率**：burst 仅用于研发；生产环境建议 watch + 合理间隔，避免对 Gamma 造成压力。

---

## 8. 参考路径索引

- 设计文档：`Polymarket-Agent交易系统设计(2).md` — 模块 2 小节  
- 模块 1 报告：[module1-market-scan-report.md](module1-market-scan-report.md)  
- 采样流程详解：[polymarket-module2-sampling-flow.md](polymarket-module2-sampling-flow.md)
