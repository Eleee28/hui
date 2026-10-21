# OpenClaw Markdown browser check

Verified 2026-09-24 using the real HUI gateway and packaged PI 0.87.1.

## Reproduce

1. Create a fresh `/tmp/hui-markdown-formatting-*` root and run
   `node e2e/fixtures/markdown-formatting-fixture.mjs <ROOT> <PI_PACKAGE>/dist/core/session-manager.js`.
   The fixture writes one disposable PI transcript plus an exclusive HUI registry.
2. Configure the disposable `hui-e2e/fixture` model using the local provider
   definition from `chat-composer.browser.md`; no model request is required.
3. Start `npm run dev` with `HOME=<ROOT>/home`, `XDG_CONFIG_HOME=<ROOT>/xdg`,
   `PI_AGENT_DIR=<ROOT>/pi-agent`, `PI_CODING_AGENT_DIR=<ROOT>/pi-agent`,
   `PI_CODING_AGENT_SESSION_DIR=<ROOT>/pi-sessions`, and `PI_OFFLINE=1`.
4. Open Home with the Browser tool and activate **Open Links and tasks**. Wait
   for the real PI transcript to resume and report Idle; do not inject DOM or app state.

## Observed

- At 1440×960, bare `https://`, `www.` and email references are safe anchors.
  The trailing full stop stays outside the documentation anchor; the GitHub
  link receives the reference icon. The URL inside inline code remains plain.
- Checked and unchecked GFM task items render as aligned, disabled checkbox
  controls, preserving transcript semantics without presenting editable state.
- CommonMark nesting, aligned pipe tables, strikethrough and the OpenClaw-style
  disclosure block render correctly. Activating **More formatting** reveals its
  body with native keyboard-operable `<details>` behavior.
- The remote image is not fetched or embedded; it renders as an **Open image**
  placeholder. Raw HTML remains escaped by the unit/security coverage.
- At 390×844, long references wrap within the message and the document has no
  horizontal overflow. Tasks, tables and nested lists remain readable.
- A fresh stable tab reported no page errors and no console error entries.

## Automated checks and scope

`npm test -- src/lib/markdown/markdown.test.ts`: 18 passed. Full `npm test`: 485 passed.
`npm run typecheck`, `npm run build`, `npm run test:package`, and
`git diff --check`: passed against the isolated `origin/main` worktree.

The implementation uses OpenClaw 2026.9.5's parser stack and pinned versions:
`markdown-it`, `markdown-it-cjk-friendly` and `markdown-it-task-lists`. HUI keeps
its existing code-block controls and table viewport, and applies the same
conservative link/image/raw-HTML safety policy. No API or persisted format changes.
