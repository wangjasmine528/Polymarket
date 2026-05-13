# Polymarket Agent 扩展（WorldMonitor 代码库内）

本仓库主体仍是 **[WorldMonitor](https://github.com/koala73/worldmonitor)** 实时情报大盘；本 **README** 只概括你完成的 **Polymarket 预测市场 Agent（设计稿模块 1～6）**、与 **prediction seed** 的接线。更细的字段与环境变量见 **[docs/reports/polymarket-seed-modules-1-4-report.md](docs/reports/polymarket-seed-modules-1-4-report.md)**、**[模块 5 执行层](docs/reports/polymarket-module5-execution-report.md)**、**[模块 6 风控](docs/reports/polymarket-module6-risk-report.md)**、**[第三步 Edge 人工审查](docs/reports/polymarket-step3-manual-review.md)**。上游架构与全站开发说明见 **[AGENTS.md](AGENTS.md)**。

---

## 你做了哪些事（一句话版）

1. **模块 1**：用规则从 Polymarket / Kalshi 原始市场里**粗筛**出一批候选（价格、流动性、点差、到期等），并做事件级去重、低价侧（YES/NO）择一。  
2. **模块 2**：按**时间序列快照 jsonl** 拼「类 K 线」与成交量差分，做 **5 类智慧资金信号**；`polymarket-kline-detect` 可单独跑。  
3. **模块 3**：Prompt、解析、融合、**edge**；Seed 默认降级，**`POLYMARKET_SEED_LLM=1`** 时对前 N 条走 **Claude 真融合**；独立 CLI `polymarket-module3-infer`。  
4. **模块 4**：Kelly + Bull/Bear/裁判；**stub** 与 **Anthropic 三阶段**；`polymarket-module4-validate`；Seed 内与模块 3 同批前 N 条可走 LLM。  
5. **模块 5**：Gamma + CLOB v2 **GTC 限价**；`polymarket-execute-order` **默认 dry-run**；**`polymarket-redis-auto-exec`** 从 Redis 读候选 → 模块 4 `judge` → 组单，带 **done 幂等 + lock**。  
6. **模块 6**：**风控规则**（止损 / 移动止损 / 止盈 / 到期强平 / 最短持有）+ CLOB **midpoint** 拉价；**`polymarket-risk-monitor`** 输出建议；**`polymarket-risk-close`** 对触发项组 **SELL**（默认 dry-run，`--execute` 真卖）。  
7. **持仓账本**：**`--execute` 成功后**默认写入 **`data/polymarket/open-positions.json`**（`.gitignore`），供模块 6 扫描/平仓；`POLYMARKET_LEDGER_APPEND=0` 可关闭。  
8. **第三步文档**：[polymarket-step3-manual-review.md](docs/reports/polymarket-step3-manual-review.md) — 导出快照、LLM vs stub 对比、人工审查清单。  
9. **工程修复**：Anthropic **默认模型**改为非退役 Haiku 4.5（`DEFAULT_ANTHROPIC_MODEL`）；Seed **首条 LLM 失败**打 `console.warn`；`runSeed` 的 **`recordCount`** 支持 **`candidates.length`**；**`.env.example`** 增加 Polymarket 变量与**勿提交密钥**说明。  
10. **与 Seed 接线**：`seed-prediction-markets.mjs` 对每条 **`candidates[]`** 挂 `smartMoney`、`probabilityEstimate`、`agentValidation`，顶层 **`polymarketEnrichment`**。

设计总纲：`Polymarket-Agent交易系统设计(2).md`。

---

## 当前进度总览（工程状态）

| 能力 | 状态 | 说明 |
|------|------|------|
| 模块 1～4 + Seed 写 Redis | 可用 | `prediction:markets-bootstrap:v1` |
| Claude LLM（前 N 条） | 可用 | `.env.local`：`ANTHROPIC_API_KEY` + `POLYMARKET_SEED_LLM=1` |
| 模块 5 单笔下单 | 可用 | `npm run polymarket:execute`；dry-run / `--execute` |
| Redis → 自动选单闭环 | 可用 | `npm run polymarket:auto-exec` |
| 模块 6 扫描 | 可用 | `npm run polymarket:risk-monitor -- --input <账本或 JSON>` |
| 模块 6 平仓执行 | 可用 | `npm run polymarket:risk-close`；默认 dry-run |
| 持仓账本 | 可用 | `auto-exec --execute` 默认追加；`POLYMARKET_POSITIONS_LEDGER_PATH` 可改路径 |
| 第三步人工审查 | 文档就绪 | 见 [polymarket-step3-manual-review.md](docs/reports/polymarket-step3-manual-review.md) |
| 模块 7 学习层 | 未做 | 设计稿仍待实现 |

**推荐流水线（小资金前）：** Seed（可选 LLM）→ 第三步审查快照 → 长期 **`auto-exec` 无 `--execute`** 攒日志 → 再 **`--execute`** → **`risk-monitor`** / **`risk-close`**（先 dry-run 再 `--execute`）。

**凭据：** API Key、私钥、账本 JSON **仅 `.env.local` 或本机路径**；勿提交（见 `.gitignore` 与 `.env.example`）。

---

## npm 脚本（Polymarket）

| 脚本 | 作用 |
|------|------|
| `npm run polymarket:execute` | 模块 5 单笔限价 |
| `npm run polymarket:auto-exec` | Redis 闭环选单 |
| `npm run polymarket:module3-infer` | 单条模块 3 Claude |
| `npm run polymarket:module4` | 模块 4 stub 演示 |
| `npm run polymarket:risk-monitor` | 模块 6 扫描（需 `--input`） |
| `npm run polymarket:risk-close` | 模块 6 平仓（默认 dry-run） |
| `npm run polymarket:sample:us-iran-peace` 等 | 模块 2 快照采样 |

---

## 主要代码在哪

| 做什么 | 文件 |
|--------|------|
| 模块 1 粗筛与候选 | `scripts/_prediction-scoring.mjs`（`buildModule1Candidates` 等） |
| 拉市场 + 跑 enrichment 写 Redis | `scripts/seed-prediction-markets.mjs` |
| 把 2/3/4 挂到每条 candidate | `scripts/_polymarket-seed-enrichment.mjs` |
| Anthropic 共用调用 | `scripts/_polymarket-anthropic.mjs` |
| 模块 2 检测与 jsonl 解析 | `scripts/_polymarket-smart-money.mjs`、`scripts/polymarket-kline-detect.mjs` |
| 模块 3 概率与 Prompt | `scripts/_polymarket-probability.mjs` |
| 模块 4 多 Agent + Kelly | `scripts/_polymarket-multi-agent.mjs`、`scripts/polymarket-module4-validate.mjs` |
| 模块 5 CLOB 执行 | `scripts/_polymarket-execution.mjs`、`_polymarket-gamma-clob.mjs`、`_polymarket-clob-trading.mjs`、`scripts/polymarket-execute-order.mjs` |
| Redis → judge → 执行闭环 | `scripts/_polymarket-loop-helpers.mjs`、`scripts/polymarket-redis-auto-exec.mjs` |
| 模块 6 风控扫描 / 平仓 | `scripts/_polymarket-risk-manager.mjs`、`_polymarket-clob-price.mjs`、`polymarket-risk-monitor.mjs`、`polymarket-risk-close.mjs` |
| 持仓账本（auto-exec 追加） | `scripts/_polymarket-positions-ledger.mjs` |
| 模块 3 单独 Claude 概率 CLI | `scripts/polymarket-module3-infer.mjs` |
| 单一事件快照采样 | `scripts/polymarket-us-iran-peace-snapshot.mjs`、burst / watch 脚本 |

---

## 怎么运行（常用命令）

**预测市场 Seed（写 Redis，需要 Redis + 外网 + 项目 `.env`）**

```bash
node scripts/seed-prediction-markets.mjs
```

**Claude LLM 模式下的 edge（模块 3 融合 + 模块 4 裁判）**

在仓库根目录创建 **`.env.local`**（已在 `.gitignore` 中，勿提交），写入：

- `ANTHROPIC_API_KEY` — 你的 Claude API Key  
- `POLYMARKET_SEED_LLM=1` — 对候选列表**前 N 条**走真实 LLM（模块 3 用 Claude 估 `P_llm` 并融合进 `probabilityEstimate`，再驱动模块 4；数值 **edge** 在 `probabilityEstimate` 与 `agentValidation.judge` 中）  
- `POLYMARKET_SEED_LLM_MAX` / `POLYMARKET_SEED_LLM_DELAY_MS` — 控制条数与请求间隔（费用与限流）

`scripts/_seed-utils.mjs` 的 `loadEnvFile` 会从 `.env.local` 加载上述变量；也可在 shell 里 `export`，但**不要把 key 写进仓库文件或 push**。

```bash
# 推荐：仅使用 .env.local，命令行不再 export 真实 key
cp .env.example .env.local
# 编辑 .env.local 填入 ANTHROPIC_API_KEY 与 POLYMARKET_SEED_LLM=1 等

node scripts/seed-prediction-markets.mjs
```

占位符与更多变量见根目录 [`.env.example`](.env.example) 中 **Polymarket Agent** 一节。

**第三步（人工审查 LLM edge）：** 按 [polymarket-step3-manual-review.md](docs/reports/polymarket-step3-manual-review.md) 导出 Redis 快照、对比 stub、填审查表。

快照 jsonl 路径（模块 2 对齐用）：默认 `data/polymarket/us-iran-peace-deal-timeseries.jsonl`，可用环境变量 **`POLYMARKET_SNAPSHOT_JSONL`** 覆盖。

**模块 2：单次采样 / 连采 / 看门**

```bash
npm run polymarket:sample:us-iran-peace
npm run polymarket:burst:us-iran-peace
npm run polymarket:watch:us-iran-peace
```

**模块 2：对 jsonl 跑检测**

```bash
node scripts/polymarket-kline-detect.mjs
node scripts/polymarket-kline-detect.mjs --help
```

**模块 4：本地演示（stub）或真 LLM**

```bash
npm run polymarket:module4
node scripts/polymarket-module4-validate.mjs --input path/to/case.json
# 使用 .env.local 中的 ANTHROPIC_API_KEY，或当前 shell 已 export（勿写入 git）
node scripts/polymarket-module4-validate.mjs --input path/to/case.json --llm
```

**模块 3：单条标题跑 Claude 概率（不写 Redis）**

```bash
npm run polymarket:module3-infer -- --title "某事件?" --price 0.33 --side yes
```

**模块 5：下单（默认 dry-run；加 `--execute` 才提交）**

```bash
npm run polymarket:execute -- --market-id <GAMMA_MARKET_ID> --outcome yes --size 1 --price 0.45
# 真实下单需 POLYMARKET_PRIVATE_KEY 等，见 docs/reports/polymarket-module5-execution-report.md
```

**闭环：读 Redis 预测 seed → 模块4 `buy`/`short` → Gamma → 限价单（默认 dry-run）**

```bash
# 与 seed 相同 Redis 环境变量；可先跑 node scripts/seed-prediction-markets.mjs
npm run polymarket:auto-exec
npm run polymarket:auto-exec -- --execute
```

**模块 6：持仓风控 + 平仓（账本默认 `data/polymarket/open-positions.json`，勿提交 git）**

```bash
# 扫描（可与 auto-exec 写入的账本同路径）
npm run polymarket:risk-monitor -- --input ./data/polymarket/open-positions.json

# 对触发风控的腿组 SELL 限价（默认 dry-run）
npm run polymarket:risk-close
npm run polymarket:risk-close -- --execute
```

详见 [polymarket-module6-risk-report.md](docs/reports/polymarket-module6-risk-report.md) 与 [polymarket-step3-manual-review.md](docs/reports/polymarket-step3-manual-review.md)。

**整站前端（与原 WorldMonitor 一致，与本 Polymarket 脚本无强依赖）**

```bash
npm install
npm run dev
```

---

## 里程碑备忘（2026-05-12）

- 模块 5 **Redis 闭环**、**幂等 / lock**、Gamma **`outcomePrices`** 与份额估算；单测 `polymarket-loop-helpers` / execution / gamma-clob。  
- 模块 6 **风控 + midpoint**；**`risk-close`**；**持仓账本**与 **`auto-exec --execute` 对接**；`risk-monitor` 支持 **`openedAtMs` → heldDays**。  
- **第三步** 人工审查文档；**Anthropic 默认模型**升级；Seed **LLM 首错日志**、**`recordCount`** 含 candidates；**`.env.example` / `.gitignore`** 与密钥说明。  
- 排障备忘：本地 Redis `8079`；seed 需外网；`--execute` 需私钥；`open-positions.json` **勿 push**。

---

## 怎么测（对应到代码）

下面命令都在仓库根目录执行。

| 测什么 | 命令 |
|--------|------|
| 模块 1 粗筛 / 候选 | `node --test tests/market-scan-coarse-filter.test.mjs` |
| 旧版 prediction 打分相关 | `node --test tests/prediction-scoring.test.mjs` |
| 模块 2 智慧资金 | `node --test tests/polymarket-smart-money-detector.test.mjs` |
| 模块 3 概率融合与 Seed 降级 | `node --test tests/polymarket-probability-estimator.test.mjs` |
| Seed 接线 + mock LLM 异步路径 | `node --test tests/polymarket-seed-enrichment.test.mjs` |
| 模块 4 Kelly / stub / mock LLM | `node --test tests/polymarket-module4-multi-agent.test.mjs` |
| 模块 5 执行 + Gamma + Redis 闭环纯函数 | `node --test tests/polymarket-execution.test.mjs tests/polymarket-gamma-clob.test.mjs tests/polymarket-loop-helpers.test.mjs` |
| 模块 6 风控 + 账本纯函数 | `node --test tests/polymarket-risk-manager.test.mjs tests/polymarket-positions-ledger.test.mjs` |
| 仓库里所有 `tests/*.test.mjs` / `.mts` | `npm run test:data` |

---

## 详细报告索引

| 文档 |
|------|
| [总览：模块 1～4 + Seed](docs/reports/polymarket-seed-modules-1-4-report.md) |
| [模块 1](docs/reports/module1-market-scan-report.md) |
| [模块 2 实现](docs/reports/polymarket-module2-implementation-summary.md) · [采样流程](docs/reports/polymarket-module2-sampling-flow.md) |
| [模块 3](docs/reports/polymarket-module3-probability-report.md) |
| [模块 4](docs/reports/polymarket-module4-multi-agent-report.md) |
| [模块 5 执行层](docs/reports/polymarket-module5-execution-report.md) |
| [模块 6 风控](docs/reports/polymarket-module6-risk-report.md) |
| [第三步：LLM Edge 人工审查](docs/reports/polymarket-step3-manual-review.md) |

---

## 许可证与上游

本树继承原项目的 **AGPL-3.0** 等条款，详见 [LICENSE](LICENSE)。商业使用请遵循原项目授权说明。
