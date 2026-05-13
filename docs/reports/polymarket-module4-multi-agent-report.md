# Polymarket Agent 模块 4 报告（多 Agent 验证）

**设计来源：** `Polymarket-Agent交易系统设计(2).md` — 模块 4：多 Agent 验证（TradingAgents 架构变体）  
**实现日期：** 2026-04-26  
**状态：** 核心库 + 离线 stub CLI + 可注入 LLM 流水线 + 单测  

**与 Seed / 模块 1–3 合并总览：** [polymarket-seed-modules-1-4-report.md](polymarket-seed-modules-1-4-report.md)

---

## 1. 实现内容

### 1.1 核心库 `scripts/_polymarket-multi-agent.mjs`

- **Kelly 头寸（与设计文档 Python 一致）**
  - `kellyPositionUsd(pTrue, pMarket, bankroll, maxFraction)`：`p_true <= p_market` 时返回 0；否则 `b=(1-p_m)/p_m`，全 Kelly 后再 `×0.25` 并 `min(..., maxFraction)`，最后 `× bankroll`。
  - `kellySafeFraction(...)`：同上，仅返回比例。
- **上下文与 Prompt**
  - `formatModule4Context(input)`：把模块 1 方向、市价、`p_true`、模块 2 `smartMoney` 等拼成裁判可读上下文。
  - `buildBullUserPrompt` / `buildBearUserPrompt` / `buildJudgeUserPrompt`：三角色 JSON-only 提示（便于接 Claude）。
- **解析**
  - `extractFirstJsonObject`：从模型输出中提取第一段 JSON（支持 markdown 围栏）。
  - `parseDebateAgentJson` / `parseJudgeDecisionJson`：校验 Bull/Bear 与裁判 JSON。
- **对侧腿（二元近似）**
  - `oppositeLegProbabilities(side, pTrue, legPrice)`：`YES` 市价 `m` 时，对侧 `p_market ≈ 1-m`，胜率为 `1-p_true`；`NO` 腿对称。
- **流水线**
  - `stubModule4Decision(input, options)`：**无网络**的确定性裁判（默认 CLI），用 `evaluateCheaperSideEdge`（模块 3）+ edge 阈值 + Kelly 是否大于 0，在 `buy` / `skip` / `short` 间选择。
  - `runModule4LlmPipeline(input, callLlm, options)`：**三次** `callLlm`（Bull → Bear → Judge），与架构图一致；`callLlm` 可注入，单测使用 mock。

### 1.2 CLI `scripts/polymarket-module4-validate.mjs`

- 默认 **stub**（不传 `--llm`）。
- `--llm` 时使用 `@anthropic-ai/sdk`，需 `ANTHROPIC_API_KEY`；模型默认见 `scripts/_polymarket-anthropic.mjs`（`DEFAULT_ANTHROPIC_MODEL`，当前为 Haiku 4.5 日期版），可用 `ANTHROPIC_MODEL` 覆盖。

### 1.3 npm 脚本

- `npm run polymarket:module4` → 等价于 `node scripts/polymarket-module4-validate.mjs --demo`（内置示例）。

### 1.4 单测 `tests/polymarket-module4-multi-agent.test.mjs`

- Kelly 边界与封顶案例（与设计公式对齐）。
- 对侧概率、Prompt、JSON 解析。
- stub：`buy` / `skip` / `short` 三种典型输入。
- mock `callLlm` 覆盖完整 LLM 流水线调用次数（3 次）。

---

## 2. 如何运行

### 2.1 离线演示（推荐）

```bash
node scripts/polymarket-module4-validate.mjs --demo
# 或
npm run polymarket:module4
```

可选资金假设：

```bash
node scripts/polymarket-module4-validate.mjs --demo --bankroll 50000
```

### 2.2 自定义输入 JSON

准备文件，例如 `case.json`：

```json
{
  "title": "某事件",
  "description": "",
  "endDate": "2026-12-31",
  "side": "yes",
  "currentPrice": 0.44,
  "pTrue": 0.56,
  "smartMoney": { "triggered": false, "score": 0, "signals": [] },
  "liquidity": 50000,
  "volume24h": 12000
}
```

运行：

```bash
node scripts/polymarket-module4-validate.mjs --input case.json
```

（仍为 stub；显式可加 `--stub`，行为相同。）

### 2.3 真实 Bull/Bear/Judge（Anthropic）

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# 可选: export ANTHROPIC_MODEL=claude-haiku-4-5-20251001
node scripts/polymarket-module4-validate.mjs --input case.json --llm
```

---

## 3. 如何测试

```bash
node --test tests/polymarket-module4-multi-agent.test.mjs
```

纳入全量数据测试套件：

```bash
npm run test:data
```

（会与其他 `tests/*.test.mjs` 一起执行。）

---

## 4. 与模块 1 / 2 / 3 的衔接说明

| 模块 | 本报告中的消费方式 |
|------|-------------------|
| 模块 1 | `side`、`currentPrice`（cheaper leg 概率）、`title` / `endDate` / 流动性等 |
| 模块 2 | `smartMoney.triggered` / `score` / `signals`（可由 `polymarket-kline-detect` 同源逻辑产出） |
| 模块 3 | `pTrue`（`fuseTrueProbability` 的 `pTrue` 或你认可的点估计） |

当前 **未** 写入 `seed-prediction-markets.mjs` Redis 载荷；模块 4 以脚本 + 库形式供流水线或后续 job 调用。

---

## 5. 后续可做

- 将模块 2、3 输出与模块 1 `candidates` 合并为一条 seed 记录或独立 JSON 批处理。
- 为 `--llm` 增加重试、超时与 schema 强校验（避免裁判 JSON 漂移）。
- 与模块 5 执行层对接时，仅传递 `judge.action` 与 `positionUsd`（及 token 侧信息）。
