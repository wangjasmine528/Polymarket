# Polymarket Agent 模块 3 报告（概率估算）

**阶段状态：** 核心能力已实现并通过单测  
**日期：** 2026-04-26  
**关联设计：** `Polymarket-Agent交易系统设计(2).md`（模块 3：概率估算）

---

## 1) 本阶段实现内容

本阶段围绕模块 3「多方法融合估算 `P_true`」完成了核心库与测试。

### 1.1 新增核心实现

文件：`scripts/_polymarket-probability.mjs`

已实现能力：

- `DEFAULT_PROBABILITY_WEIGHTS`：默认权重
  - `llm=0.4`
  - `baseRate=0.2`
  - `news=0.25`
  - `corr=0.15`
- `normalizeWeights(weights)`：权重归一化（和为 1，非法值保护）
- `buildProbabilityPrompt(input)`：生成模块 3 所需中文 Prompt（含事件、描述、到期、市场隐含概率、新闻上下文）
- `parseLlmProbabilityJson(raw)`：解析并校验 LLM 返回 JSON（`probability/reasoning/uncertainty/confidence`）
- `sentimentToProbability(score)`：新闻情绪分数映射为概率（默认中性 0.5）
- `aggregateCorrelationProbability(relatedMarkets)`：相关市场概率聚合（支持权重）
- `fuseTrueProbability(components, options)`：多分量融合得到 `pTrue`，支持缺失分量与有效权重重整
- `evaluateCheaperSideEdge({ pTrue, currentPrice, side })`：基于模块 1 cheaper-side 输出计算边际优势（edge）

### 1.2 新增测试

文件：`tests/polymarket-probability-estimator.test.mjs`

覆盖点：

- 权重归一化与回退
- Prompt 生成
- LLM JSON 解析与清洗
- 情绪概率映射
- 相关市场聚合
- 概率融合与 edge 计算（yes/no）

---

## 2) 与设计文档的对齐说明

已按模块 3 公式实现基础框架：

`P_true = w1 * P_llm + w2 * P_base_rate + w3 * P_news + w4 * P_corr`

对应映射：

- `P_llm` → `components.llm`
- `P_base_rate` → `components.baseRate`
- `P_news` → `components.news`
- `P_corr` → `components.corr`

并落地了初始权重（0.4 / 0.2 / 0.25 / 0.15），后续可在实盘/回测后调整。

---

## 3) 终端测试记录（用户提供区间 957-1025）

以下为本阶段两段关键命令与结果。

### 3.1 命令一：模块 3 单测

```bash
node --test tests/polymarket-probability-estimator.test.mjs
```

输出结果（摘录）：

```text
▶ probability module weight handling
  ✔ normalizes custom weights to sum=1 (0.554625ms)
  ✔ falls back to defaults when all custom weights invalid (0.249166ms)
✔ probability module weight handling (1.156166ms)
▶ probability module prompt and llm parsing
  ✔ builds chinese prompt with market implied probability (0.07975ms)
  ✔ parses llm json and sanitizes confidence/reasoning (0.093334ms)
✔ probability module prompt and llm parsing (0.273875ms)
▶ probability module component transforms
  ✔ maps sentiment score to implied probability (0.107875ms)
  ✔ aggregates correlation probability with optional weights (0.141958ms)
✔ probability module component transforms (0.426875ms)
▶ probability module fusion and edge
  ✔ fuses p_true with confidence anchoring (0.18425ms)
  ✔ supports missing components by renormalizing effective weights (0.044917ms)
  ✔ computes cheaper-side edge for yes/no correctly (0.125167ms)
✔ probability module fusion and edge (0.506667ms)
ℹ tests 9
ℹ suites 4
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 37.248041
```

结论：**全部通过（9/9）**。

### 3.2 命令二：概率融合 + edge 示例调用

```bash
node --input-type=module -e "
import {
  fuseTrueProbability,
  evaluateCheaperSideEdge
} from './scripts/_polymarket-probability.mjs';

const fused = fuseTrueProbability(
  { llm: 0.62, baseRate: 0.48, news: 0.55, corr: 0.57 },
  { llmConfidence: 'medium' }
);

const edge = evaluateCheaperSideEdge({
  pTrue: fused.pTrue,
  currentPrice: 0.44,
  side: 'yes'
});

console.log(JSON.stringify({ fused, edge }, null, 2));
"
```

输出结果：

```json
{
  "fused": {
    "pTrue": 0.55695,
    "pTrueRaw": 0.567,
    "usedWeights": {
      "llm": 0.4,
      "baseRate": 0.2,
      "news": 0.25,
      "corr": 0.15
    },
    "components": {
      "llm": 0.62,
      "baseRate": 0.48,
      "news": 0.55,
      "corr": 0.57
    }
  },
  "edge": {
    "sideProb": 0.55695,
    "marketProb": 0.44,
    "edge": 0.11694999999999994,
    "hasEdge": true
  }
}
```

结论：示例输入下，`pTrue > pMarket`，存在正 edge（`hasEdge=true`）。

---

## 4) Seed 接线与「连接前后」区别

**合并总览（含模块 4、可选 Seed 内真实 Claude）：** [polymarket-seed-modules-1-4-report.md](polymarket-seed-modules-1-4-report.md)

### 已接入 `seed-prediction-markets.mjs`（与模块 1/2/4 一并）

`prediction:markets-bootstrap:v1` 里每条 **`candidates[]`** 现在会多出：

| 字段 | 含义 |
|------|------|
| `smartMoney` | 模块 2：若存在可选快照 jsonl 且 `marketId` 命中，则为检测摘要；否则 `available: false` 及原因（非 Polymarket、无文件、无匹配行）。 |
| `probabilityEstimate` | 模块 3：**不调用 LLM** 的 `buildSeedProbabilityEstimate`（`mode: seed_degraded`）：`P_llm=null`，`P_base_rate=0.5`，`P_news` 中性，`P_corr` 为其它 Polymarket 候选 `yesPrice` 聚合（若有）；含 `pTrue` / `edge` 等。 |
| `agentValidation` | 模块 4：`stubModule4Decision` 的精简输出（`judge` / `kelly` / `edge` 等）。 |

顶层增加 **`polymarketEnrichment`** 元数据（快照路径、是否读到文件、行数、命中数等）。

**环境变量：**

- `POLYMARKET_SNAPSHOT_JSONL` — 快照 jsonl 路径；默认 `data/polymarket/us-iran-peace-deal-timeseries.jsonl`（与模块 2 采样脚本一致）。
- `POLYMARKET_MODULE4_BANKROLL` — stub 裁判 Kelly 用的名义资金（默认 `10000`）。

### 连接前 vs 连接后

| 维度 | 连接前 | 连接后 |
|------|--------|--------|
| `candidates[]` | 仅模块 1 粗筛字段 | 同上 + `smartMoney` + `probabilityEstimate` + `agentValidation` |
| 模块 2 | 仅 CLI `polymarket-kline-detect` 读 jsonl | Seed 若读到同一 jsonl，会把**命中**的 Polymarket `marketId` 的检测结果写入对应 candidate |
| 模块 3 | 库 / 手工调用 | Seed 内写 **`seed_degraded`** 概率（非生产 LLM）；全候选仍有一条可消费的 `pTrue` |
| 模块 4 | 仅独立 CLI | Seed 内对每个 candidate 跑 **stub** 多 Agent 摘要 |
| 载荷体积 | 较小 | 随候选数量增加；`polymarketEnrichment` 仅一小段元数据 |

### 下一步建议

1. 接入真实 `P_llm`（Claude）等分量时，在 cron seed 外单独 job 或限流，避免 seed 超时与费用。
2. 为 Redis 载荷做体积监控或裁剪 `insufficientBySignal` 等大字段（按需）。
3. 多事件快照：为更多 `eventSlug` 维护 jsonl 或改为按 `marketId` 拉历史后再写 `smartMoney`。

