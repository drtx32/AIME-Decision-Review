## Hermes WebUI adaptation notes

The shell work was adapted after inspecting the Hermes WebUI repository and its
UI/UX and lifecycle guidance, rather than copying its runtime. The inspected
reference was `nesquena/hermes-webui` at the current upstream HEAD on 2026-09-23.

Relevant reference material:

- `docs/UIUX-GUIDE.md`: fixed sidebar, conversation-first hierarchy, stable
  composer command surface, and responsive behavior.
- `docs/ui-ux/index.html`: right-aligned message actions, attachment chips,
  edit mode, cancellation copy, and reconnect affordances.
- `docs/rfcs/stable-assistant-turn-anchor-phase0.md`: session re-entry,
  stream cancellation/settlement, deduplication, and reload recovery.
- `tests/test_inflight_send_start_race.py` and the browser-smoke workflow:
  lifecycle regression coverage around in-flight requests and browser flows.

| Hermes invariant | AIME adaptation |
| --- | --- |
| Conversation-first shell | Compact left session navigation, independently scrolling center conversation, AIME Findings/Evidence/Learning context panel. |
| Stable command surface | `composer-dock` owns the composer; notices and attachments are absolutely stacked above it so its layout anchor remains stable. |
| Session re-entry | The authenticated user's current session id is restored from browser storage and rehydrated from the AIME session API after reload. |
| Cancel/settle lifecycle | Stop aborts the browser request and calls the server cancel endpoint; cancelled runs cannot persist normal completed findings. |
| Mature message actions | Copy/edit/delete/retry actions are keyboard-focusable; server edit/delete invalidates downstream session output. |
| Settings isolation | Settings is rendered through a viewport-level portal and preserves the underlying draft/session when closed. |
| Attachment affordance | Composer chips preserve draft text; the picker allowlists image, DOCX, XLSX, CSV, and PDF extensions. |

AIME-specific boundaries remain intact: no Hermes terminal/worktree/agent
control features, no managed session runtime, and no forwarding of provider or
MCP credentials to the browser. The current MVP keeps attachment metadata local
to the composer; server upload/parsing is a separate integration seam.
