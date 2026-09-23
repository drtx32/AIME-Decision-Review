# AIME 决策复盘

面向 AIME 评测的 AI-native 历史投资决策复盘产品。

> English version: [README.md](./README.md)

## 问题

个人或研究型投资者在回顾一笔已经发生的投资决策时，通常会陷入两种失败模式：

- **结果偏差（Outcome bias）。** 赚钱的交易被一概判定为「做对了」，亏钱的交易被一概判定为「做错了」，完全忽略当初做出决策的过程是否合理。
- **事后视角（Ex-post hindsight）。** 把决策之后才公开的信息倒灌回决策推理，拼出一个「当时不可能成立的」完美叙事。

在这两种失败模式下提取出的复盘结论也是错的：它们只是在强化「最后是赚是亏」，并且无法迁移到下一次决策。

## 解决方案

AIME 决策复盘强制做 **T0 冻结** 的复盘：

1. 用户用一段自然语言描述一笔历史交易。
2. `DecisionExtractorAgent` 产出一个或多个结构化的 `DecisionCandidate`（标的、动作、价格、时间、理由）。
3. 用户确认（或编辑）这些抽取出的决策。
4. `DecisionReviewAgent` 规划证据检索，调用 Fuyao / iFinD MCP，按 `publishedAt` 把每一条证据切分为 `exAnte`（≤ T0）或 `exPost`（> T0），做一次有界的反思，返回结构化的 `DecisionReviewResult`。
5. `decisionQuality` 与 `outcome` 作为 **两个独立的对象** 返回，绝不合并。
6. Lessons 与下一次决策 Checklist 都基于引用过的证据，并明确区分事实 / 推断 / 不确定性。

如果某条工具调用返回 `empty` / `transient_error` / `permanent_error`，复盘会被降级为 `partial` 或 `failed`。**工具失败绝不变成「没数据」。**

## 关键流程

```text
用户输入自然语言
   │
   ▼
DecisionExtractorAgent  ──  结构化 DecisionCandidate[]
   │
   ▼
用户确认（或编辑）
   │
   ▼
DecisionReviewAgent      ──  状态机
   │                          created → planning → retrieving →
   │                          analyzing → reflecting → completed |
   │                          partial | failed
   │
   ▼
结构化 DecisionReviewResult
   │   decisionQuality | outcome | attribution | biases | missedEvidence |
   │   lessons | nextChecklist | uncertainties | citations
   │
   ▼
Findings / Evidence / Learning 面板
```

两个 agent 故意分开：

- **`DecisionExtractorAgent`**（`apps/api/src/agents/decision-extractor.ts`）
  只做 LLM 端的 **结构化抽取**。它不调用 MCP、不产出 `DecisionReviewResult`、也不评判决策本身。
- **`DecisionReviewAgent`**（`apps/api/src/agents/decision-review.ts`）
  拥有 **完整的复盘生命周期**。证据检索、T0 对齐、反思都在代码中完成（而不是在 LLM 中），LLM 仅参与结构化评判层。OpenAI Agents SDK 集成通过 `runWithOpenAIAgents` 可选启用，默认不开启。

## 演示输入

规范的演示输入是简化版的茅台交易：

```text
我 2024-03-15 在 ¥1,720 买了 600519（贵州茅台）。
当时看了 2023 年报，现金流稳定，估值回到五年中枢。
二季度回调我扛住了，三季度反弹。
```

在该输入上的预期流水线：

- `DecisionExtractorAgent` 返回 1 条 candidate，`timePrecision: "exact"`、`executedAt: "2024-03-15T…Z"`、`action: "buy"`、`price: 1720`、`needsConfirmation: []`。
- 用户确认后，`DecisionReviewAgent` 进入 `planning`，选择 `fuyao:a-share`、`fuyao:a-share-index`、`ifind:news`、`ifind:edb`，可能还有 `ifind:enterprise`，跑完生命周期后返回 `completed`，Findings / Evidence / Learning 面板被填充。

近似 T0、多标的、连续未成交等变体，参见 `submission/TEST_NOTES.md` §"Golden-path matrix"。

## 规范项目文档

所有 agent 与贡献者必须在实现前、或在上下文不确定时阅读仓库文档：

- `docs/SPEC.md` — 规范的产品与技术规格
- `docs/AI_VALIDATION.md` — AI 使用与验证日志
- `docs/TEST_PLAN.md` — 必需的测试覆盖与证据
- `docs/AUTOMATION.md` — GitHub Actions → Multica 监督
- `docs/DEPLOYMENT.md` — 规范的生产路径、Compose 固定、密钥、备份与回滚
- `docs/THIRD_PARTY.md` — 第三方依赖授权与参考代码归属边界

如果 Issue 与 `docs/SPEC.md` 冲突，以更新的 Issue 指令为准；其他情况以文档为准。

## 安全

任何 API Key、Authorization 头、MCP 凭据、Cookie、Webhook URL 都不得提交到仓库。统一使用服务器环境变量 / GitHub Secrets。

## LLM 提供方

生产环境的 LLM 提供方是 **MiniMax-M3**，通过 `apps/api/src/providers/` 中的 `openai-compatible` 适配器访问。凭据（`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL=MiniMax-M3`）只从服务器 `.env` 加载，绝不进入仓库。`mock` 提供方是 fixture / CI 运行的默认值。

## 生产部署路径

生产部署必须在以下路径运行：

```text
/root/projects/aime-decision-review
```

不要在 `/root/multica_workspaces/...` 或其他临时 agent / issue 工作区跑生产。迁移、SQLite volume 保留、回滚等细节见 `docs/DEPLOYMENT.md`。

## 用 Docker Compose 运行

根目录的 Compose 文件把静态前端和 Bun/Hono API 分别打包到两个服务。浏览器的 `/api` 请求走 web 容器的 Nginx 反向代理。SQLite 放在具名 `api-data` volume。

```bash
cp .env.example .env
chmod 600 .env
docker compose up -d --build
```

默认对外暴露的只有 web 容器，监听 `http://localhost:13608`。API 容器监听 Compose 内部端口 `3000`，只能通过 web 反向代理访问，例如：

```bash
curl -fsS http://127.0.0.1:13608/health
curl -fsS http://127.0.0.1:13608/api/health
```

只有在宿主机 web 端口需要变更时，才在根 `.env` 设置 `WEB_PORT`。后端凭据只传给 API 容器，不会暴露给前端。仅前端开发时，`npm install && npm run dev` 可以使用内置的 dev mock 适配器（除非设置了 `VITE_API_BASE_URL`）。根 `.env.example` 是唯一的运行时配置模板，不要新建 app-local `.env.example`。

## 提交材料骨架（submission skeleton）

`submission/` 是可复现的提交前包：清单、AI 使用 / 验证记录（区分 fixture 与真实验证）、部署证据模板、授权 / 归属清单，以及 `scripts/preflight.mjs`——它会验证工作目录已可提交，并（可选）打包出确定的 ZIP。

```bash
# 在仓库根目录：
node scripts/preflight.mjs                 # 仅校验——发现问题退出码非零
node scripts/preflight.mjs --zip out.zip  # 校验 + 生成确定的提交 ZIP

# preflight 脚本自身的测试（bun:test，跑在 apps/api 的测试运行器里）：
cd apps/api && bun test ../../tests/preflight/
```

`submission/MANIFEST.md` 列出哪些必须 / 不得随包发布；`submission/DEPLOYMENT_EVIDENCE.md` 是生产部署验证后由人工填写的部署记录。

## 架构概览

```text
浏览器
  └─ React + TypeScript + Vite + Bun（src/、根 npm workspace）
      │  /api/* 由 Nginx 反代到 API 容器
      ▼
Hono（apps/api，Bun 运行时）
  ├─ routes/api.ts          POST /api/reviews、GET …/events、GET …/result、GET /health
  ├─ routes/auth/*          login / logout / me / change-password / admin users
  ├─ agents/decision-extractor.ts  仅做 LLM 端结构化抽取
  ├─ agents/decision-review.ts     单一有界 agent：
  │                                 T0 → plan → retrieve → align → reflect → result
  ├─ agents/reflection.ts          一次有界自检（T0 泄漏、
  │                                 数字一致性、反证忽视、
  │                                 结果污染）
  ├─ mcp/registry           Fuyao（6）+ iFinD（11），广泛配置、
  │                         按 intent 惰性解析
  ├─ mcp/adapters/*         MockFuyao / MockIFind / LiveMcp（凭据 +
  │                         intent→tool map 齐全时走 JSON-RPC 2.0）
  ├─ providers/             极简 LLM 提供方抽象（mock +
  │                         openai-compatible，生产 MiniMax-M3）
  ├─ db/sqlite              ReviewRepository + UserRepository（bun:sqlite）
  └─ config.ts              环境变量解析，缺失密钥时 fail-fast
```

### Fuyao / iFinD MCP

MCP 注册表（`apps/api/src/mcp/registry.ts`）保存完整的六 Fuyao + 十一 iFinD 服务集合，但 **启动时不枚举所有工具 schema**。适配器由复盘计划按需惰性解析：

- **Fuyao**（`meta`、`a-share`、`a-share-index`、`fund`、`futures`、`options`）：`meta` 用于解析标的 / 能力；`a-share` / `a-share-index` 覆盖常见股票复盘上下文；`fund`、`futures`、`options` 在支持的场景下提供跨资产上下文。
- **iFinD**（`ds`、`enterprise`、`law`、`stock`、`fund`、`edb`、`news`、`bond`、`global-stock`、`index`、`futures`）：`stock` / `index` / `news` / `edb` 覆盖常见股票复盘上下文；`fund` / `futures` / `global-stock` / `bond` 视条件启用；`enterprise` / `law` 处理公司 / 法律案例；需要时用 `ds` 检查实际暴露的能力。

三种行为路径：

1. **未配置凭据** → `MockFuyaoAdapter` / `MockIFindAdapter`（确定式、诚实的 `transient_error` / `permanent_error` / `empty` 分支）。
2. **配置了凭据但没有 `HITHINK_FINANCE_TOOL_MAP` / `IFIND_MCP_TOOL_MAP`** → 该服务没有 live 适配器（拒绝虚构工具名）。
3. **凭据 + 操作员提供的 tool map 齐全** → `LiveMcpAdapter` 驱动 JSON-RPC 2.0（`initialize` → `tools/list` → `tools/call`）。服务的真实凭据验证进行中；参见 `submission/AI_VALIDATION_RECORD.md`。

工具适配器区分四类结果：`success` / `empty` / `transient_error` / `permanent_error`。工具失败绝不变成「没数据」，而是一个明确的缺口，复盘会被降级为 `partial` 或 `failed`。

### T0 / ex-ante / ex-post 设计

T0 在架构层（而非 prompt 层）识别：

- `DecisionExtractorAgent` 返回每条 candidate 时带 `timePrecision: "exact" | "approximate" | "unknown"`，并附 ISO `executedAt`（exact 且 grounded 时）或 `null`（仅有文本或近似时间时）。
- `DecisionReviewAgent` 把每条证据按 `publishedAt`（**绝不**用 `retrievedAt`）分类为 `exAnte`（`publishedAt ≤ T0 − 1d`，含一个明确的端日 tolerance）或 `exPost`（`publishedAt ≥ T0 + 14d`，示例下限）。
- `decisionQuality` 只基于 `exAnteEvidence` 推理；`outcome` 只基于 `exPostEvidence` 推理。返回结构在 JSON 层强制这种分离。
- 一次有界的反思 pass 检查：是否有 ex-post 漏进 ex-ante？是否有结果污染了决策质量？未支撑的因果声明是否被标为不确定？见 `apps/api/src/agents/reflection.ts`。

产品级 trace（SSE 流）只暴露产品级事件——不暴露隐藏的 chain-of-thought。依据 `docs/SPEC.md` §15。

## 测试命令（速查）

```bash
# 前端类型检查 + 生产构建：
npm ci && npm run build

# 后端类型检查 + bun:test：
cd apps/api && bun install --frozen-lockfile && bun run typecheck && bun test

# 容器烟囱测试：
docker compose config
docker compose build
```