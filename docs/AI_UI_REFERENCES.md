## UI and agent interaction references

AIME borrows interaction patterns, not managed ChatKit or private ChatGPT UI:

- [openai/openai-chatkit-starter-app](https://github.com/openai/openai-chatkit-starter-app)
  (MIT): self-hosted chat shell, composer, session lifecycle, loading and
  recoverable error affordances.
- [openai/chatkit-js](https://github.com/openai/chatkit-js) (Apache-2.0):
  message/tool-part rendering, source annotations and thread/session UX.
- [openai/openai-agents-js ai-sdk-ui example](https://github.com/openai/openai-agents-js/tree/main/examples/ai-sdk-ui)
  (MIT): stream event → UI message-part mapping, including tool/status parts.
- [OpenAI Agents MCP human-in-the-loop example](https://github.com/openai/openai-agents-js/blob/main/examples/mcp/hosted-mcp-human-in-the-loop.ts)
  (MIT): interruption/approval/resume lifecycle for tools.

The current AIME implementation keeps its MiniMax/OpenAI-compatible provider,
Bun/Hono API, SQLite session model, PulseRelay-derived sidebar, and AIME
domain panels. Backend status messages and persisted assistant summaries are
the local equivalent of streamed message/tool parts; no OpenAI managed session
or client token is required.
