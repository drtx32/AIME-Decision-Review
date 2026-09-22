# AIME Decision Review · Web Shell

## 启动
在仓库根目录执行 `bun install && bun run dev`，生产构建使用 `bun run build`。仅允许配置非敏感的 `VITE_API_BASE_URL`；API key、MCP Authorization 和模型密钥只能由服务端持有。

## 容器

从仓库根目录构建前端镜像：

```sh
docker build -f apps/web/Dockerfile --build-arg VITE_API_BASE_URL="$VITE_API_BASE_URL" -t aime-web .
docker run --rm -p 8080:80 aime-web
```

静态资源由 nginx 提供，`/health` 返回 `200 ok`，并且所有前端路由回退到 `index.html`。`VITE_API_BASE_URL` 仅是公开的后端地址；不要将任何密钥作为 build arg 或环境变量传给前端镜像。

## 页面结构
Home 输入历史决策；Running 展示不含 chain-of-thought 的产品级进度；Result 以 T0 为界并列 Ex-Ante / Ex-Post 证据，区分 Decision Quality 与 Outcome，并提供归因、Lessons、Checklist 与引用。

## 当前边界
前端默认使用固定 mock adapter，后端未完成时也能完整演示。设置 `VITE_API_BASE_URL` 后切换到真实 adapter，接入 POST `/api/reviews` 和 GET `/api/reviews/:id/result`；进度页面仍只展示产品级阶段，不展示模型思考过程。
