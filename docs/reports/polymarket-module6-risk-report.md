# 模块 6：风险控制层（RiskManager）

**设计来源：** `Polymarket-Agent交易系统设计(2).md` — 模块 6（副线，约每 30 秒）  
**实现：** 纯函数风控 + CLOB 公开 midpoint 拉价 + CLI 单次/循环扫描  

---

## 1. 规则（与设计稿一致，可 JSON 覆盖）

| 字段 | 默认 | 含义 |
|------|------|------|
| `stop_loss_pct` | `0.4` | 相对入场价亏损 ≥40% → 建议平仓 |
| `take_profit_pct` | `0.6` | 盈利 ≥60% → 建议止盈 |
| `trailing_stop_pct` | `0.15` | 从峰值回撤 ≥15% → 建议移动止损平仓 |
| `trailing_arm_pct` | `0.2` | 盈利 ≥20% 后才启用移动止损（设计稿硬编码 20%） |
| `min_days_to_hold` | `1` | 未满持有天数：不因止损/移动止损/止盈平仓（**到期强平仍执行**） |
| `force_close_days` | `1` | `daysToExpiry ≤ 1` → 建议到期前平仓 |

实现：`scripts/_polymarket-risk-manager.mjs`（`evaluatePositionRisk`、`monitorPositions`）。

---

## 2. 市价来源

公开 `GET /midpoint`、`GET /midpoints`（无需私钥）。封装：`scripts/_polymarket-clob-price.mjs`。

---

## 3. CLI

```bash
# 一轮扫描（自动拉 CLOB midpoint）
node scripts/polymarket-risk-monitor.mjs --input ./my-positions.json

# 每 30s 循环（副线）
node scripts/polymarket-risk-monitor.mjs --input ./my-positions.json --watch --interval-ms 30000

# 离线：持仓 JSON 里自带 currentPrice01，加 --no-fetch
node scripts/polymarket-risk-monitor.mjs --input ./my-positions.json --no-fetch

# 自定义规则
node scripts/polymarket-risk-monitor.mjs --input ./my-positions.json --rules-json ./my-risk-rules.json
```

npm：`npm run polymarket:risk-monitor -- --input ./my-positions.json`

**注意：** 当前脚本**只输出 JSON 建议**（`action: close` + `reason`），不调用撤单/卖单；与模块 5 执行层解耦，避免误操作。

---

## 4. 持仓 JSON 形状

```json
[
  {
    "tokenId": "1234567890",
    "entryPrice01": 0.35,
    "peakPrice01": 0.42,
    "daysToExpiry": 5,
    "heldDays": 2
  }
]
```

- `shares`：**平仓**时 `polymarket-risk-close` 使用；`risk-monitor` 仅扫描价格可忽略。  
- `openedAtMs`：若提供，`risk-monitor` 可用其推导 `heldDays`（覆盖静态 `heldDays`）。  
- 输出里带 `suggestedPeakPrice01`，便于把峰值写回文件做跨次持久化。

**推荐：** 从 `data/polymarket/open-positions.example.json` 复制结构；真实账本默认 **`data/polymarket/open-positions.json`**（已在 `.gitignore`，勿提交）。

---

## 5b. 持仓账本（与 `--execute` 衔接）

- **`polymarket-redis-auto-exec --execute`** 在订单提交并写入 Redis `done` 后，默认向 **`POLYMARKET_POSITIONS_LEDGER_PATH`**（默认 `data/polymarket/open-positions.json`）**追加/覆盖**同 `tokenId` 的一条 open 记录（含 `entryPrice01`、`shares`、`daysToExpiry` 等）。  
- 关闭账本：`POLYMARKET_LEDGER_APPEND=0` 或 `false`。  
- 实现：`scripts/_polymarket-positions-ledger.mjs`。

**然后** 可用同一文件作为 `risk-monitor` 的 `--input`，无需手抄 token。

---

## 5c. 平仓执行 CLI（默认 dry-run）

```bash
# 仅打印将对哪些 token 下 SELL 限价
npm run polymarket:risk-close

# 真实提交 SELL（需私钥）；默认成功后从账本移除该 token
npm run polymarket:risk-close -- --execute
```

- 脚本：`scripts/polymarket-risk-close.mjs`。  
- **`--no-remove`**：成功后仍保留账本行（便于对账）。  
- 仍应先跑 **`polymarket:risk-monitor`** 核对 `close` 原因再 `--execute`。

---

## 6. 第三步人工审查（Edge 可信度）

见专门文档：[polymarket-step3-manual-review.md](polymarket-step3-manual-review.md)（导出快照、对比 LLM vs stub、审查清单）。

---

## 7. 单测

```bash
node --test tests/polymarket-risk-manager.test.mjs tests/polymarket-positions-ledger.test.mjs
```

---

## 8. 与闭环的关系（摘要）

| 阶段 | 工具 |
|------|------|
| 选单 + 开仓 | `polymarket:auto-exec`（`--execute` 写 Redis `done` + 可选账本） |
| 副线扫描 | `polymarket:risk-monitor --input <ledger 或自建 JSON>` |
| 平仓 | `polymarket:risk-close`（默认 dry-run；`--execute` 下 SELL） |
| Edge 人工审查 | [polymarket-step3-manual-review.md](polymarket-step3-manual-review.md) |
