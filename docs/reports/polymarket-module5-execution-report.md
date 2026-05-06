# 模块 5：执行层（CLOB 下单）

**设计来源：** `Polymarket-Agent交易系统设计(2).md` — 模块 5  
**实现日期：** 2026-04-30  

---

## 1. 实现了什么

| 内容 | 位置 |
|------|------|
| 限价概率 + 滑点（设计稿 `_calculate_limit_price` 语义） | `scripts/_polymarket-execution.mjs`：`calculateLimitPriceProbability`、`buildUserOrderFromDecision` |
| Gamma 取 `clobTokenIds`、选 YES/NO token | `scripts/_polymarket-gamma-clob.mjs` |
| CLOB v2 客户端（viem 签名 + `createOrDeriveApiKey` + GTC） | `scripts/_polymarket-clob-trading.mjs` |
| CLI：**默认 dry-run**；`--execute` 才真下单 | `scripts/polymarket-execute-order.mjs` |
| **Redis → 模块4 → 模块5 闭环**（候选、`judge`、Gamma、幂等、可选真下单） | `scripts/polymarket-redis-auto-exec.mjs`、`scripts/_polymarket-loop-helpers.mjs` |

依赖（已写入 `package.json`）：`@polymarket/clob-client-v2`、`viem`。

---

## 2. 怎么运行

**先 dry-run（不要私钥，只打印计划单）：**

```bash
node scripts/polymarket-execute-order.mjs --market-id <GAMMA_MARKET_ID> --outcome yes --size 1 --price 0.45
```

**市价概率省略时**：会尝试用 Gamma 返回的 `outcomePrices`；失败则必须传 `--price`。

**真实下单：**

```bash
export POLYMARKET_PRIVATE_KEY=0x你的私钥
# 可选: export POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/...
# 可选: export POLYMARKET_SIGNATURE_TYPE=0   # 0 EOA, 1 Proxy, 2 Gnosis
# 可选: export POLYMARKET_FUNDER_ADDRESS=0x...
node scripts/polymarket-execute-order.mjs --market-id <ID> --outcome yes --size 1 --price 0.45 --execute
```

官方 Quickstart：<https://docs.polymarket.com/quickstart/first-order>

---

## 2b. Redis 闭环（自动选单 + 幂等）

从 **`prediction:markets-bootstrap:v1`** 读 `candidates[]`，筛 **`source === polymarket`** 且 **`agentValidation.judge.action`** 为 `buy` / `short`（可用 `--actions` 限制），按模块 1 顺序扫描；跳过已在 Redis 标记成功的 `(marketId, outcome)`；对命中项加 **短期 SET NX 锁** 再拉 Gamma、算份额、组限价单。

```bash
# 需 UPSTASH_REDIS_REST_*（可先 applySelfHostRedisRestDefaults / 与 seed 相同 .env）
npm run polymarket:auto-exec
# 真下单
npm run polymarket:auto-exec -- --execute
```

常用环境变量：`POLYMARKET_AUTO_MAX_USD`（名义 cap）、`POLYMARKET_AUTO_MAX_SCAN`、`POLYMARKET_AUTO_DEDUPE_TTL_SEC`、`POLYMARKET_AUTO_DEDUPE_PREFIX`。

**裁判语义**：`buy` = 买模块 1 当前腿（`side`）token；`short` = 买**对侧** outcome token。份额 ≈ `floor(min(judge.positionUsd, cap) / 市价)`，上下限 `--min-shares` / `--max-shares`。

幂等键：`{prefix}:done:v1:{marketId}:{outcome}`；并发锁：`{prefix}:lock:v1:{marketId}:{outcome}`。

---

## 3. 模块 3 独立 LLM CLI（补全「单独跑 Claude 概率」）

不经过 Seed，仅测一条标题的融合结果：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node scripts/polymarket-module3-infer.mjs --title "某事件?" --price 0.33 --side yes
```

脚本：`scripts/polymarket-module3-infer.mjs`。

---

## 4. 单测

```bash
node --test tests/polymarket-execution.test.mjs tests/polymarket-gamma-clob.test.mjs tests/polymarket-loop-helpers.test.mjs
```

---

## 5. 「少量资金自动跑」**仍缺什么**（闭环脚本之后）

单脚本已覆盖：**Redis 候选 → 模块4 动作 → Gamma token → 限价 GTC + 幂等**。要做到**长期无人值守、风险可控**，通常还需要：

1. **调度** — cron / Railway 定时跑 `seed-prediction-markets` + `polymarket:auto-exec`（顺序由你定：先刷新 judge 再执行）。

2. **模块 6 类能力** — 成交/撤单、持仓上限、多市场总敞口、失败告警（本仓库未实现）。

3. **资金与授权** — Funder **USDC**、**allowance**、`POLYMARKET_SIGNATURE_TYPE` 与账户一致。

4. **合规与地区** — 自行确认条款与地域限制。

5. **运行环境** — 稳定 **RPC**、**密钥托管**（切勿进 git）。

---

## 6. 相关文档

- [polymarket-seed-modules-1-4-report.md](polymarket-seed-modules-1-4-report.md) — Seed 与模块 1–4  
- [polymarket-module4-multi-agent-report.md](polymarket-module4-multi-agent-report.md) — 模块 4  

---

## 7. 2026-05-06 运行排障记录（最新）

1. `polymarket:auto-exec -- --execute` 报错 `Set POLYMARKET_PRIVATE_KEY...`：  
   这是**预期行为**，因为 `--execute` 会进入真实签名/下单路径，必须提供私钥。

2. 模拟跑通（不真实交易）所需条件：  
   - 仅运行不带 `--execute` 的 dry-run。  
   - 不需要私钥；公开读接口（Gamma / CLOB 读端点）即可完成选单与组单。

3. 今日环境确认：  
   - Redis REST：`http://localhost:8079`（token `wm-local-token`）可用。  
   - Gamma 连通性在排障后恢复（Node 直连 `/events?limit=1` 返回 200）。

4. 常见失败根因与结论：  
   - 若 seed 阶段外网拉取失败（`fetch failed`），`prediction:markets-bootstrap:v1` 不会写入，auto-exec 会提示 no snapshot/candidates。  
   - 解决顺序：先 `seed-prediction-markets` 成功写候选，再跑 `polymarket:auto-exec`。
