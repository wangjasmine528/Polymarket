# 第三步：LLM 模式 Edge 人工审查指南

**目标：** 在启用 `POLYMARKET_SEED_LLM` 后，判断 **Claude 融合概率 + 模块 4 裁判** 算出的 **edge** 是否可信，再决定是否进入「长期 dry-run 观察」与小额实盘。

**前置：** 已完成 [polymarket-seed-modules-1-4-report.md](polymarket-seed-modules-1-4-report.md) 中的 Seed + LLM 配置；`seed LLM stats` 中 `ok` 应接近 `attempted`（失败则先看 `llmFallbackError` 与模型 id）。

---

## 1. Edge 在数据里出现在哪

对每条 **`candidates[]`** 中的 Polymarket 候选：

| 字段 | 含义 |
|------|------|
| `probabilityEstimate.pTrue` | 融合后的「事件为真」概率估计 |
| `probabilityEstimate.edge` | 当前模块 1 腿上的数值 edge（与 `hasEdge` 一致来源） |
| `probabilityEstimate.hasEdge` | 是否认为该腿相对市价有正 edge |
| `probabilityEstimate.llmFallbackError` | **仅失败时出现**：LLM 未跑通，本条为降级估计 |
| `agentValidation.mode` | `llm` 或 `stub` |
| `agentValidation.judge.edge` | 裁判输出的标量 edge（LLM 路径下来自 judge JSON） |
| `agentValidation.judge.action` / `positionUsd` | 裁判动作与名义头寸 |

**人工审查重点：** 同时看 **`probabilityEstimate`** 与 **`agentValidation`**；若 `llmFallbackError` 存在，本条 **不是** LLM edge，不要纳入「LLM vs 降级」对比。

---

## 2. 导出 Redis 快照到本地（便于 diff / 表格）

在仓库根目录、已配置 `UPSTASH_REDIS_REST_*` 的 shell 中：

```bash
node -e "
import('./scripts/_seed-utils.mjs').then(async (m) => {
  m.loadEnvFile(import.meta.url);
  const s = await m.readSeedSnapshot('prediction:markets-bootstrap:v1');
  const fs = await import('node:fs/promises');
  await fs.writeFile('prediction-snapshot.json', JSON.stringify(s, null, 2));
  console.log('wrote prediction-snapshot.json candidates=', s?.candidates?.length);
});
"
```

**注意：** 快照里**不要**再粘贴 API Key；若需分享，先删掉 `candidates` 里与隐私无关字段或只截取前 N 条。

---

## 3. 建议审查步骤（每条前 N 条 LLM 候选）

1. **筛 LLM 成功条**  
   - `agentValidation.mode === 'llm'` 且无 `probabilityEstimate.llmFallbackError`。

2. **看概率是否离谱**  
   - `pTrue` 是否在 (0,1) 且与标题常识大致一致；极端 0.01 / 0.99 需标红复核。

3. **看 edge 与市价**  
   - `currentPrice`（模块 1 腿）与 `pTrue`：edge 应反映「模型概率 − 市价」方向（见 `_polymarket-probability.mjs` 中 `evaluateCheaperSideEdge`）。

4. **看裁判与模块 3 是否打架**  
   - `judge.action` / `judge.rationale` 是否与 `probabilityEstimate` 同向；若经常反向，检查 Prompt 或提高 `POLYMARKET_SEED_LLM_DELAY_MS` 降低限流噪声。

5. **记录结论表**（示例列）  
   - `marketId` | `title` | `side` | `currentPrice` | `pTrue` | `edge` | `judge.action` | `judge.edge` | 人工评级（合理/偏高/偏低）| 备注 |

---

## 4. LLM vs 降级（stub）对比怎么做

1. **快照 A（LLM）：** `POLYMARKET_SEED_LLM=1`，`POLYMARKET_SEED_LLM_MAX=N`，跑 seed，导出 `prediction-snapshot-llm.json`。  
2. **快照 B（降级）：** 关闭 `POLYMARKET_SEED_LLM` 或 unset，再跑 seed，导出 `prediction-snapshot-stub.json`。  
3. 用脚本或表格按 **`marketId` + `side`** join，对比同一市场的 `probabilityEstimate.edge` / `pTrue`。

若 **LLM 明显压低 edge / hasEdge 变少**：说明降级路径可能偏乐观。  
若 **LLM 普遍更高 edge**：检查融合权重与 judge Prompt，避免过拟合标题。

---

## 5. 通过标准（建议，可自行收紧）

- 前 N 条 LLM 样本中，**人工标记「明显不合理」占比**低于你设定阈值（例如 &lt; 20%）。  
- **裁判与概率层**严重矛盾比例可接受。  
- 无大量 `llmFallbackError`（否则先修模型/额度/网络）。

通过后：进入 README 中的 **第四步** — 以 **dry-run auto-exec + 日志** 为主跑一至两周，再考虑 `--execute` 与 [模块 6 风控](polymarket-module6-risk-report.md)。

---

## 6. 相关脚本（不写密钥到文档）

| 用途 | 命令 |
|------|------|
| Seed + LLM | `node scripts/seed-prediction-markets.mjs`（环境见 `.env.local`） |
| 单条模块 3 | `npm run polymarket:module3-infer -- --title "..." --price ... --side yes` |
| 单条模块 4 | `node scripts/polymarket-module4-validate.mjs --input case.json --llm` |
| 闭环 dry-run | `npm run polymarket:auto-exec` |

密钥仅存在于 **`.env.local`** 或部署密钥管理，**勿提交**（见根目录 `.gitignore` 与 `.env.example` 安全说明）。
