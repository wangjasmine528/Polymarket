# Polymarket Agent 扩展（WorldMonitor 代码库内）

本仓库主体仍是 **[WorldMonitor](https://github.com/koala73/worldmonitor)** 实时情报大盘；本 **README** 只概括你完成的 **Polymarket 预测市场 Agent（设计稿模块 1～4）**、与 **prediction seed** 的接线。更细的字段与环境变量见 **[docs/reports/polymarket-seed-modules-1-4-report.md](docs/reports/polymarket-seed-modules-1-4-report.md)**。上游架构与全站开发说明见 **[AGENTS.md](AGENTS.md)**。

---

## 你做了哪些事（一句话版）

1. **模块 1**：用规则从 Polymarket / Kalshi 原始市场里**粗筛**出一批候选（价格、流动性、点差、到期等），并做事件级去重、低价侧（YES/NO）择一。  
2. **模块 2**：按**时间序列快照 jsonl**（多次采样同一事件）拼出「类 K 线」的 `closes` / 成交量差分，做 **5 类智慧资金信号**；可用 CLI 单独跑检测。  
3. **模块 3**：按设计稿做多源融合（`P_llm`、基准率、新闻、相关市场）；实现 **Prompt、解析、融合、edge**；Seed 里默认用**不调用 API 的降级版**，也可对前 N 条打开 **Claude 真融合**。  
4. **模块 4**：**Kelly** + **Bull / Bear / 裁判** 的 Prompt 与 JSON 解析；**离线 stub** 与 **Anthropic 三阶段** 两种路径；Seed 里默认 stub，可选与 CLI 相同的真实辩论。  
5. **与 Seed 接线**：在 `seed-prediction-markets.mjs` 里，对每条 **`candidates[]`** 挂上 `smartMoney`、`probabilityEstimate`、`agentValidation`，并写顶层 **`polymarketEnrichment`** 元数据。

设计总纲：`Polymarket-Agent交易系统设计(2).md`。

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
| 单一事件快照采样 | `scripts/polymarket-us-iran-peace-snapshot.mjs`、burst / watch 脚本 |

---

## 怎么运行（常用命令）

**预测市场 Seed（写 Redis，需要 Redis + 外网 + 项目 `.env`）**

```bash
node scripts/seed-prediction-markets.mjs
```

可选：**真实 Claude（模块 3 + 模块 4）** 只处理列表里**前 N 条**候选（注意费用与限流）：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export POLYMARKET_SEED_LLM=1
export POLYMARKET_SEED_LLM_MAX=5
export POLYMARKET_SEED_LLM_DELAY_MS=450
node scripts/seed-prediction-markets.mjs
```

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
export ANTHROPIC_API_KEY=...
node scripts/polymarket-module4-validate.mjs --input path/to/case.json --llm
```

**整站前端（与原 WorldMonitor 一致，与本 Polymarket 脚本无强依赖）**

```bash
npm install
npm run dev
```

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

---

## 许可证与上游

本树继承原项目的 **AGPL-3.0** 等条款，详见 [LICENSE](LICENSE)。商业使用请遵循原项目授权说明。
