# Polymarket Agent：模块 1–4 与 Seed 接线总报告

**Redis 键：** `prediction:markets-bootstrap:v1`  
**Seed 脚本：** `scripts/seed-prediction-markets.mjs`  
**报告日期：** 2026-04-30（含真实 LLM Seed 路径更新）  

本文档单独汇总：**模块 1 粗筛 → 模块 2/3/4 在 Seed 内的合并方式**（含可选 **Anthropic 真实** 模块 3 + 模块 4）、**模块 4 独立 CLI**，以及连接前后差异。细节分报告见文末索引。

---

## 1. 总览：现在一条 Seed 里有什么

`fetchAllPredictions()` 在完成 Gamma/Kalshi 拉取与 **模块 1** `buildModule1Candidates` 后，会：

1. 尝试读取 **Polymarket 快照 jsonl**（模块 2 同源时间序列）。
2. 对每条 **`candidates[]`** 调用 `enrichCandidatesWithModules234Async`（`scripts/_polymarket-seed-enrichment.mjs`），挂上 **模块 2 / 3 / 4** 字段（默认降级；开启 `POLYMARKET_SEED_LLM` 时对前 N 条走 **Claude 模块 3 + 三阶段模块 4**）。
3. 在返回对象顶层增加 **`polymarketEnrichment`** 元数据。

`geopolitical` / `tech` / `finance` 仍为模块 1 时代的 `filterAndScore` 列表，**未**逐条嵌入模块 2–4（与 `candidates` 的定位不同：`candidates` 是粗筛后的「研究池」）。

```text
Gamma/Kalshi markets
        → buildModule1Candidates  →  candidates[]
        → load jsonl (optional)   →  detectSmartMoneyFromSnapshots
        → per candidate: smartMoney + probabilityEstimate + agentValidation（可选 LLM）
        → Redis payload
```

---

## 2. Seed 内接线（模块 1 + 2 + 3 + 4）

### 2.1 涉及文件

| 文件 | 角色 |
|------|------|
| `scripts/seed-prediction-markets.mjs` | 拉数、`buildModule1Candidates`、读快照、可选 Anthropic、`enrichCandidatesWithModules234Async`、`polymarketEnrichment` |
| `scripts/_polymarket-seed-enrichment.mjs` | 快照检测、降级或 LLM 路径的模块 3/4 写入 |
| `scripts/_polymarket-anthropic.mjs` | 共用 `createAnthropicCallLlm()`（Seed 与 `polymarket-module4-validate --llm`） |
| `scripts/_polymarket-smart-money.mjs` | 模块 2：`parsePolymarketSnapshotJsonl`、`detectSmartMoneyFromSnapshots` |
| `scripts/_polymarket-probability.mjs` | 模块 3：`buildSeedProbabilityEstimate`、`buildFusedProbabilityEstimateFromLlmParse`、`buildProbabilityPrompt` 等 |
| `scripts/_polymarket-multi-agent.mjs` | 模块 4：`stubModule4Decision`、`runModule4LlmPipeline`、Kelly、Prompt |

### 2.2 环境变量

| 变量 | 含义 | 默认 |
|------|------|------|
| `POLYMARKET_SNAPSHOT_JSONL` | 模块 2 快照 jsonl 绝对或相对路径 | `data/polymarket/us-iran-peace-deal-timeseries.jsonl`（相对仓库根） |
| `POLYMARKET_MODULE4_BANKROLL` | Kelly 名义资金（美元）；降级 stub 与 LLM 裁判均使用 | `10000` |
| `POLYMARKET_SEED_LLM` | 设为 `1` 或 `true` 时，对前 N 条 candidate 调用 **真实** Anthropic（模块 3 + 模块 4 共 4 次请求/条） | 关闭 |
| `POLYMARKET_SEED_LLM_MAX` | 启用 LLM 时最多处理候选条数（从列表**开头**计） | `5` |
| `POLYMARKET_SEED_LLM_DELAY_MS` | 每条「LLM 候选」处理前的间隔（毫秒），减轻限流 | `450` |
| `ANTHROPIC_API_KEY` | 启用 `POLYMARKET_SEED_LLM` 时**必填** | — |
| `ANTHROPIC_MODEL` | 可选模型 id；未设置时用代码内默认（当前为 **Haiku 4.5** 日期版，避免已退役 3.5 Haiku） | 见 `DEFAULT_ANTHROPIC_MODEL` |
| `ANTHROPIC_TIMEOUT_MS` | 可选，单次 Messages 请求超时（毫秒）；`0` 表示不额外限制 | `0` |

**凭据安全：** 只把 `ANTHROPIC_API_KEY` 放在本机 **`.env.local`**（仓库已 `.gitignore`），勿写入可被提交的 Markdown、勿贴进 issue/聊天。`scripts/_seed-utils.mjs` 的 `loadEnvFile` 会加载 `.env.local`。

文件不存在时：**不失败**；`smartMoney` 对多数候选为 `available: false`（见下文字段说明）。

**启用真实文稿链路示例：**

```bash
# 在 .env.local 中设置 ANTHROPIC_API_KEY、POLYMARKET_SEED_LLM=1、POLYMARKET_SEED_LLM_MAX 等后：
node scripts/seed-prediction-markets.mjs
```

### 2.3 顶层字段 `polymarketEnrichment`

写入 seed 载荷，便于监控与排查：

- `snapshotPath`：实际尝试读取的路径  
- `snapshotLoaded`：是否成功读到文件  
- `snapshotRecordRows`：解析后的快照「行」数（jsonl 记录条数）  
- `snapshotMarketsDetected`：在快照上跑完检测后得到的 **市场条数**（Map 大小）  
- `smartMoneyAttached`：有多少条 **candidate** 与快照中 `marketId` **命中**并写入了完整 `smartMoney`  
- `candidateCount`：enrichment 时的候选条数  
- `seedLlm`：是否启用了真实 LLM 路径（`ANTHROPIC_API_KEY` 存在且 `POLYMARKET_SEED_LLM` 开启）  
- `llmCandidatesAttempted` / `llmCandidatesSucceeded` / `llmCandidatesFailed`：LLM 子集统计  
- `llmMaxConfigured`：本次配置的 `POLYMARKET_SEED_LLM_MAX` 上限  

### 2.4 每条 `candidates[]` 新增字段

#### `smartMoney`（模块 2）

- **`available: true`**：`source === 'polymarket'` 且在快照检测表里命中同一 `marketId`。包含 `triggered`、`score`、`signals`、`bars`、`volumeBars`、`gateReason`、`insufficientBySignal` 等（与 `polymarket-kline-detect` 同源结构）。  
- **`available: false`**：  
  - `reason: not_polymarket_source`（Kalshi 等）  
  - `reason: no_snapshot_records`（未读到 jsonl 或为空）  
  - `reason: market_not_in_snapshot`（Polymarket 但快照里从未出现该 `marketId`）

**说明：** 当前默认快照来自 **单一事件** 采样脚本；全站 `candidates` 里只有落在该时间序列里的市场会有 `available: true`。多事件需扩展多条 jsonl 或后续按 `marketId` 拉历史。

#### `probabilityEstimate`（模块 3）

- **降级（默认）**：`buildSeedProbabilityEstimate`，`mode: seed_degraded`；无 `P_llm`。  
- **真实（`POLYMARKET_SEED_LLM` + Key，且该条在「前 N 条」内）**：`buildProbabilityPrompt` → Claude JSON → `parseLlmProbabilityJson` → **`buildFusedProbabilityEstimateFromLlmParse`**，`mode: llm_fused`；含 `llmExtraction`（reasoning / uncertainty / confidence）。与设计权重融合后再算 `edge`。  
- 若 LLM 调用失败：回退为 `seed_degraded`，并可能带 `llmFallbackError` 字段。  
- 超出前 N 条的候选：始终为 `seed_degraded`。

启用 LLM 后的 **人工审查步骤与导出命令** 见：[polymarket-step3-manual-review.md](polymarket-step3-manual-review.md)。

#### `agentValidation`（模块 4）

- **降级（默认或超出 N）**：`stubModule4Decision` 精简输出（`mode: stub`）。  
- **真实（同「前 N 条」条件）**：`runModule4LlmPipeline`（Bull → Bear → Judge），精简为 `mode: llm`，含 `bull`、`bear`、`judge`、`kelly`、`edge` 等。  
- 若模块 4 LLM 失败：与模块 3 失败类似，回退 stub（`probabilityEstimate` 可能已为降级）。

---

## 3. 模块 4（独立能力 + 与 Seed 的关系）

### 3.1 设计对齐

对应 `Polymarket-Agent交易系统设计(2).md`：**Bull / Bear 辩论 → 风险裁判 → Kelly → buy / skip / short**。

### 3.2 代码与入口

| 能力 | 位置 |
|------|------|
| Kelly、Prompt、JSON 解析、stub、LLM 流水线 | `scripts/_polymarket-multi-agent.mjs` |
| 本地 CLI（`--demo` / `--input` / `--llm`） | `scripts/polymarket-module4-validate.mjs` |
| npm | `npm run polymarket:module4`（内置 `--demo`） |
| 单测 | `tests/polymarket-module4-multi-agent.test.mjs` |

### 3.3 运行方式（独立调试）

```bash
node scripts/polymarket-module4-validate.mjs --demo
npm run polymarket:module4
node scripts/polymarket-module4-validate.mjs --input case.json
export ANTHROPIC_API_KEY=...
node scripts/polymarket-module4-validate.mjs --input case.json --llm
```

### 3.4 Seed 里 vs CLI 里

| 场景 | 模块 4 行为 |
|------|-------------|
| **Seed（默认）** | **stub** |
| **Seed（`POLYMARKET_SEED_LLM=1` + Key，前 N 条）** | **`runModule4LlmPipeline`**（与 CLI `--llm` 同源） |
| **CLI `--demo` / `--input`** | 默认 stub；**`--llm`** 时走 `runModule4LlmPipeline`（共用 `_polymarket-anthropic.mjs`） |

更细的模块 4 说明见：[polymarket-module4-multi-agent-report.md](polymarket-module4-multi-agent-report.md)。

---

## 4. 连接前 vs 连接后

| 维度 | 连接前 | 连接后 |
|------|--------|--------|
| `candidates[]` | 仅模块 1 输出字段 | 每条增加 `smartMoney`、`probabilityEstimate`、`agentValidation` |
| 模块 2 | 仅 CLI / 单测读 jsonl | Seed **可选**读同一 jsonl，命中则写入对应 candidate |
| 模块 3 | 库与手工示例 | Seed 默认 **降级**；可选 **`llm_fused`（Claude，前 N 条）** |
| 模块 4 | 独立 CLI | Seed 默认 **stub**；可选 **真实 Bull/Bear/Judge（前 N 条，与 CLI 同源）** |
| 顶层 | 无 enrichment 元数据 | 增加 `polymarketEnrichment`（含 `seedLlm` 与 LLM 统计） |
| `validateFn` | 只校验 geo/tech/finance | 额外要求 **`candidates` 为数组** |

---

## 5. 如何验证（测试命令）

**Seed 接线与降级概率：**

```bash
node --test tests/polymarket-seed-enrichment.test.mjs
node --test tests/polymarket-probability-estimator.test.mjs
```

（`polymarket-seed-enrichment` 中含 **mock `callLlm`** 的异步 LLM 路径单测，无需真实 Key。）

**模块 4：**

```bash
node --test tests/polymarket-module4-multi-agent.test.mjs
```

**全量数据测试（含上述文件）：**

```bash
npm run test:data
```

**端到端 Seed（需 Redis + 外网）：**

```bash
node scripts/seed-prediction-markets.mjs
```

（需按项目惯例配置 Redis 与 `.env`。）

---

## 6. 后续建议（非本次范围）

1. **成本与超时**：`POLYMARKET_SEED_LLM_MAX` 每条候选约 **4 次** API；生产 cron 可改为独立 worker 或异步队列。  
2. **模块 2 覆盖**：多 `eventSlug` 快照或按 `marketId` 拉取历史，提高 `smartMoneyAttached` 比例。  
3. **新闻上下文**：模块 3 Prompt 中 `newsContext` 可接 RSS/摘要，再喂给 Claude。  
4. **载荷体积**：按需裁剪 `insufficientBySignal` 或大段 `llmExtraction`。

---

## 7. 相关文档索引

- 模块 1：[module1-market-scan-report.md](module1-market-scan-report.md)  
- 模块 2 实现与采样：[polymarket-module2-implementation-summary.md](polymarket-module2-implementation-summary.md)、[polymarket-module2-sampling-flow.md](polymarket-module2-sampling-flow.md)  
- 模块 3 概率库与终端示例：[polymarket-module3-probability-report.md](polymarket-module3-probability-report.md)  
- 模块 4 CLI 与 LLM：[polymarket-module4-multi-agent-report.md](polymarket-module4-multi-agent-report.md)  
- 设计总纲：`Polymarket-Agent交易系统设计(2).md`  
