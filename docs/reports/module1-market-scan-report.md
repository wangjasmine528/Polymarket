# 模块 1：市场扫描与粗筛 — 实现报告

**日期：** 2026-04-22  
**范围：** Polymarket Agent 设计文档中「模块 1：市场扫描 & 粗筛」的落地实现、相关单测流程，以及一次本地 seed 冒烟运行结果说明。

---

## 1. 概述

已实现可配置的 **模块 1** 流水线：对 Polymarket（Gamma）与 Kalshi 拉取结果做归一化，按设计文档做粗筛，按事件在 YES/NO 中选低价侧（隐含赔率更高），按事件去重、排序、截断 Top-N，并在预测市场 seed 载荷中除原有 `geopolitical` / `tech` / `finance` 分组外，新增 **`candidates`** 数组。

---

## 2. 已实现功能

### 2.1 配置（`scripts/_prediction-scoring.mjs`）

| 项 | 说明 |
|----|------|
| `FILTER_CONFIG` | 与设计对齐的默认阈值：`min_price` / `max_price`、`min_volume_24h`、`min_liquidity`、`max_spread_pct`、`min_days_to_expiry` / `max_days_to_expiry`、`must_be_active`、`must_accept_orders`。 |
| `RELAXED_FILTER_CONFIG` | 当严格过滤通过数量低于 `minTarget`（如 50）时使用的放宽阈值。 |
| 旧版打分映射 | `shouldInclude` / `filterAndScore` 通过 `LEGACY_SCORING_FILTER_CONFIG` 表达，保持与原先严格 10–90%、放宽 5–95% 等行为一致，避免破坏现有 UI / bootstrap 消费逻辑。 |

### 2.2 纯函数与辅助逻辑（同一文件）

- **`parseNumber` / 价格归一化** — 在适用场景下同时接受 0–1 与 0–100 形式。
- **`computeSpreadPct(market)`** — 优先使用显式 `spreadPct`；否则由 `bestBid` / `bestAsk`（及常见别名字段）推算。
- **`computeDaysToExpiry(endDate, now)`** — 距离结算的剩余天数（可为小数）。
- **`pickCheaperSide(yesPrice, noPrice)`** — 选择价格更低的一侧；必要时由 YES 推断 NO。
- **`normalizeCoarseMarket(raw, now)`** — 产出统一内部行：`marketId`、`eventId`、`side`、`currentPrice`（概率 0–1 浮点）、成交量、流动性、价差、到期相关字段、活跃与接单标志、标签、URL 等。
- **`passesCoarseFilter(market, config, now)`** — 应用模块 1 全部过滤门限。
- **`dedupeByEventAndCheaperSide(markets)`** — 每个 `eventId` 至多一条；优先更低 `currentPrice`，相同时用更高 `volume24h` 决胜。
- **`buildModule1Candidates(rawMarkets, options)`** — 完整链路：归一化 → 严格过滤 → 可选放宽回退 → 去重 → 打分 → 截取 `maxCandidates`（默认 100）→ 稳定输出结构（含 `metadata`：`isActive`、`acceptingOrders`）。返回 `{ candidates, stats }`。

### 2.3 Seed 接入（`scripts/seed-prediction-markets.mjs`）

- 为每条原始数据补充 **`marketId`**、**`eventId`**、**`volume24h`**、**`liquidity`**、可用的 bid/ask/spread、**`isActive`**、**`acceptingOrders`**（兼容 Polymarket 与 Kalshi 字段形态）。
- 在 `fetchAllPredictions()` 聚合后执行 **`buildModule1Candidates(markets, { minTarget: 50, maxCandidates: 100 })`**。
- 打印 **`module1 stats`**（`raw`、`normalized`、`strictPassed`、`passed`、`deduped`、`usedRelaxed`）及 **`module1 candidates: N`**。
- 发布载荷包含 **`candidates`**，并保留 **`geopolitical`**、**`tech`**、**`finance`** 列表（对既有消费者向后兼容）。

### 2.4 相关修复（保障全量 `test:data`）

- **`server/worldmonitor/market/v1/analyze-stock.ts`** — `fetchDividendProfile` 的分红频率推断：合并 **近一年分红笔数** 与 **历史完整自然年的年均笔数**，避免季度分红在跨年边界被误判为 `Semi-annual`。（解除与模块 1 无关、但在同一次全量 `test:data` 中会跑到的 `stock-dividend-profile` 失败。）

---

## 3. 测试过程

### 3.1 计划中的两条命令（与你的执行一致）

**命令 A — 模块 1 粗筛单测**

```bash
npm run test:data -- tests/market-scan-coarse-filter.test.mjs
```

- **框架：** `package.json` 中 `test:data` 使用 `tsx --test` 跑 `tests/*.test.mjs` 与 `tests/*.test.mts`；注意在末尾追加路径时，**仍会执行整个 glob 下的全部测试**，你指定的文件只是其中一部分。
- **文件：** `tests/market-scan-coarse-filter.test.mjs`
- **覆盖（12+ 场景）：** 价格上下界、成交量与流动性下限、价差上限、到期窗口 `[min_days, max_days]`、活跃与接单双开关、非法或缺失字段、YES/NO 低价侧选择、事件级去重、Top-100 上限、严格通过数不足时的放宽回退、输出契约（`marketId`、`currentPrice`、`metadata` 等），以及对 `computeSpreadPct`、`computeDaysToExpiry` 的辅助校验。

**命令 B — 预测打分回归**

```bash
npm run test:data -- tests/prediction-scoring.test.mjs
```

- **文件：** `tests/prediction-scoring.test.mjs`
- **覆盖：** `parseYesPrice`、`isExcluded`、`isMemeCandidate`、`tagRegions`、`shouldInclude`、`scoreMarket`、`isExpired`、`filterAndScore`、meme 回归等 — 确保模块 1 改动未破坏既有 bootstrap 打分行为。

**你本地运行结果：** 两条命令均 **全部通过**（同一次 `test:data`  invocation 内也会包含其它测试套件，整体为绿）。

### 3.2 可选：仅跑两个 `.mjs` 文件（缩短反馈）

不跑全量 glob 时可用：

```bash
node --test tests/prediction-scoring.test.mjs tests/market-scan-coarse-filter.test.mjs
```

---

## 4. Seed 冒烟 — 示例输出解读

在配置好 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`（见 `SELF_HOSTING.md`）后，一次成功本地运行示例：

| 指标 | 示例值 | 含义 |
|------|--------|------|
| `total raw markets` | 278 | 各 tag 拉取事件 + Kalshi 合并后的原始行数。 |
| `module1 stats` | `strictPassed=57`，`usedRelaxed=false` | 严格配置已满足 `minTarget`，未走放宽分支。 |
| `module1 candidates` | 57 | 落在设计目标 **50–100** 区间内。 |
| `geopolitical/tech/finance` | 各 25 | 旧有 capped 列表仍正常产出。 |
| Redis | `Verified: data present in Redis` | `prediction:markets-bootstrap:v1` 写入成功。 |

---

## 5. 后续工作（Future Work）

1. **`test:data` 与单文件过滤** — 当前会跑全量 `tests/*.test.mjs` / `*.test.mts`；可增加 npm 脚本支持「只跑指定文件」，缩短本地与 CI 反馈时间。
2. **Seeder 的 dry-run** — 例如 `node scripts/seed-prediction-markets.mjs --dry-run`，在无 Redis 时仅打印 `candidates` 与统计，便于本地上手。
3. **Polymarket 字段映射收紧** — 当 Gamma 稳定提供 `spread` / `liquidity` / `acceptingOrders` 时，减少启发式推断，并用真实 payload 加固测试。
4. **消费端接线** — 若产品需要「模块 1 观察列表」，在 bootstrap 类型与 UI 面板中显式消费 `candidates`。
5. **调度与 TTL** — 按需将 cron 调到 10 分钟等；保持 `CACHE_TTL` 与「允许连续未跑次数」一致（见 seed 脚本内注释）。
6. **可观测性** — 将 `module1 stats` 输出为结构化日志或指标（如 `candidates_count`、`usedRelaxed`），在候选数低于下限或放宽模式频繁触发时告警。

---

## 6. 参考

- 设计：`Polymarket-Agent交易系统设计(2).md` — 「模块 1：市场扫描 & 粗筛」。
- 本地 Redis 环境变量：`SELF_HOSTING.md`（约第 105–106 行）。
- 代码：`scripts/_prediction-scoring.mjs`、`scripts/seed-prediction-markets.mjs`、`tests/market-scan-coarse-filter.test.mjs`、`tests/prediction-scoring.test.mjs`。
