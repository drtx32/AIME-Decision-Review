# AIME Decision Review · Web Shell

## 启动
在仓库根目录执行 `bun install && bun run dev`，生产构建使用 `bun run build`。仅允许配置非敏感的 `VITE_API_BASE_URL`；API key、MCP Authorization 和模型密钥只能由服务端持有。

## 页面结构
Home 输入历史决策；Running 展示不含 chain-of-thought 的产品级进度；Result 以 T0 为界并列 Ex-Ante / Ex-Post 证据，区分 Decision Quality 与 Outcome，并提供归因、Lessons、Checklist 与引用。

## 当前边界
前端默认使用固定 mock adapter，后端未完成时也能完整演示。真实 adapter 应接入 POST `/api/reviews`、GET `/api/reviews/:id/events` 和 GET `/api/reviews/:id/result`。
