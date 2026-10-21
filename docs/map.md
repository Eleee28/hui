# Code map

A short map for finding your way around HUI. It names owners, not every file:
each module starts with a header comment saying what it owns, so open the
file the map points at and read its first lines. Product contracts live in
`SPEC.md` and `docs/api.md`; the scoped `AGENTS.md` files hold the rules for
editing each directory.

## The shape

```
browser (src/)  ──/__hui/ JSON + WebSocket──▶  gateway (server/)  ──▶  Pi Durable harness (SQLite)
                                                 │                    PI SDK worker (legacy sessions)
cli/  starts, stops and updates the gateway ─────┘                    remote workers (server/worker/)
desktop/  wraps the same UI in Electron
```

The browser never touches the filesystem or child processes; everything goes
through typed `/__hui/` routes. The gateway owns HUI's state under
`~/.config/hui`, PI owns its configuration and credentials under `~/.pi`, and
Pi Durable owns conversations, runs, queues and crash recovery.

## Dependency rules

`scripts/boundaries.test.mjs` checks these in `npm test`, with no exceptions.

- R1. `src/` imports only `src/` and npm packages; production `src/` code
  imports no Node module.
- R2. `server/`, `cli/`, `desktop/` and `bin/` never import `src/`.
- R3. There is no `shared/` directory.
- R4. `server/` and `cli/` may import each other; `desktop/` imports only
  `desktop/`; `bin/` imports `cli/`, `server/`, `desktop/` and `build/`.
- R5. Only `src/api/` calls `fetch`, `new WebSocket` or `new EventSource`.
- R6. `src/lib/` imports nothing from `src/controllers/`, `src/components/` or
  `src/views/`, and only types from `src/api/`, except `*-store.ts` modules,
  which cache what the API returns.
- R7. `src/views/` imports nothing from `src/controllers/` or `src/hui-app.ts`.
  Only `src/components/` and `src/hui-app.ts` register custom elements.
- R8. Production code in `server/runtimes/` and `server/sessions/` never imports
  `server/bots/`; the core reaches bots through `configureDurableBots`.
- R9. `server/optchat/` imports only itself and npm packages.
- R10. No import cycles inside `src/`, `server/` or `cli/`, type-only imports
  included.
- R11. Product code never imports `e2e/`, `evals/` or `scripts/`. Those may
  import either side, and tests may import their fixtures.
- R12. No file imports both `src/` and `server/`.
- R13. No test reads `src/hui-app.ts` or `src/controllers/` as text: tests
  render views and drive controllers instead.
- R14. The remote worker release ships every module that
  `server/worker/main.ts`, `server/worker/host.ts` and `server/runtimes/` load.
- R15. `server/api/` imports only `typebox` and itself.
- R16. `src/api/schema/` matches the types generated from `docs/api.schema.json`,
  checked by `scripts/api-schema.test.ts`.
- R17. Installed entry points keep their paths: `bin/hui.mjs`, `cli/launch.ts`,
  `cli/main.ts`, `cli/gateway-run.ts`, `server/runtimes/pi-sdk-worker.ts`,
  `server/worker/main.ts` and `index.html`. An installed CLI checks their built
  files before switching to a new release.

## A message, start to finish

1. **Composer** (`src/controllers/composer-controller.ts`, `src/lib/composer/state.ts`) builds the
   prompt with its attachments and draft.
2. **Client API** (`src/api/sessions.ts`) posts it to
   `/__hui/sessions/:id/prompt` (or `steer`, `follow-up`, `queue`) with a
   request id (`src/lib/composer/send-requests.ts`) that a resend after a failure reuses.
3. **Route** (`server/routes/session-actions.ts`, reached through
   `server/hui.ts`) validates the request and hands it to the live session;
   `server/sessions/recent-requests.ts` answers a resent id with the first
   send's outcome instead of sending it again.
4. **Live session** (`server/sessions/live-sessions.ts`) keeps exactly one runtime per
   session and forwards the prompt through the generic contract in
   `server/runtimes/types.ts`.
5. **Runtime adapter**: `server/runtimes/durable.ts` for Durable sessions (the
   harness itself is `durable-host.ts`), `pi.ts` / `pi-sdk-worker.ts` for
   sessions still on PI, `remote.ts` for sessions on a remote worker.
6. **Events** flow back over a WebSocket per open session view
   (`server/sessions/transport.ts`, opened with a single-use ticket) to the
   client store.
7. **Rendering**: `src/views/chat/projection.ts` turns transcript state into
   what the chat shows; tool cards live beside it in `src/views/chat/`.

## server/ — the gateway

| Area | Start here |
|---|---|
| HTTP entry and routing | `hui.ts` (the `/__hui/` dispatch: the `x-hui` gate, the diagnostics hook, route modules in order, the session and bot event streams), `services.ts` (the gateway's services and route modules, built at import time), `backend.ts` (backend start, startup recovery and stop), `vite-plugin.ts` (`huiConfig`: the API, backend and upgrades inside Vite's dev and preview servers), `server/routes/` (one `createXRoutes(deps)` module per area; `order.test.ts`: which handler answers each route family, in dispatch order), `server/http/` (`route.ts`: the request and result every route module speaks, request body reading and JSON answers; `events.ts`: server-sent events and the session event feed; `static-files.ts`; `compression.ts`: Brotli/gzip for files and JSON), `gateway.ts` (process start), `host.ts` (bind address) |
| Published API schema | `server/api/` (TypeBox payloads and route metadata; `index.ts`: area catalog and JSON Schema document; `diagnostics.ts`: health, redacted snapshots and UI error reports), `docs/api.schema.json` (generated contract), `scripts/api-schema.ts` (publication and browser type generation), `server/test-support/api-schema.ts` (test-only conformance checks) |
| Session registry and lifecycle | `server/sessions/sessions.ts` (HUI registry), `server/api/sessions.ts` (session, group, stage, list-update, questionnaire and metric payloads), `server/api/session-events.ts` (session stream frames, snapshots, transcripts, transmitted runtime events, open and clear responses), `server/sessions/` (`session-tree.ts`: a session's tree root and descendants; `slash-commands.ts`: reserved command parsing; `lifecycle.ts`: create, fork, worktree launch, update and delete; `views.ts`: session views and the session list; `session-stages.ts`: stage rules and precedence; `attachments.ts`: prompt attachment limits, decoding and the attachment store; `stages.ts`: an agent's `set_stage`; `progress-card.ts`: transcript progress snapshots; `thinking.ts`: accepted reasoning levels; `live-sessions.ts`: running sessions; `list.ts`: the shared list and its update frames; `transport.ts`: the session view WebSocket; `activity.ts`: when each session was worked on; `digest.ts`: a session summary for utility drafting; `interrupted-run.ts`: resuming a lost run; `recent-requests.ts`: a resent request id's first outcome), `routes/attachments.ts` (`GET /__hui/sessions/:id/attachments/…`), `routes/sessions.ts` (the session list and groups, `POST /__hui/sessions`, `PATCH/DELETE /__hui/sessions/:id`), `routes/session-actions.ts` (`/__hui/sessions/:id/<action>`: open, prompt, queue, model, fork and the rest) |
| Runtimes | `runtimes/types.ts` (contract), `runtimes/command-references.ts` (runtime command aliases), `runtimes/durable*.ts` (Pi Durable: host, adapter, prompt, tools, PI extensions, questions; `durable-offer.ts`: the tool offer every conversation shares), `runtimes/turn-origins.ts` (history entries every conversation may hold, and who started a bot's turn), `runtimes/pi*.ts` (PI SDK worker and CLI fallback), `runtimes/pi-import.ts` (moves PI sessions to Durable for `hui doctor --fix`), `runtimes/model-controls.ts` (a model's reasoning levels, fast mode and the level HUI's Ultra is sent) |
| HUI agent tools | `runtimes/hui-tools.ts` (definitions), `server/agent-tools/` (`bridge.ts`: loopback bridge for PI workers; `subagents.ts`; `subagent-completion.ts`: completion event writing and continuation prompts; `watchers.ts` with `routes/watchers.ts`; `task-suggestions.ts`: the suggestion store, limits, start modes and prompt text, with `routes/task-suggestions.ts`; `secret-requests.ts`; `questionnaires.ts`; `presented-media.ts`: files shown with present_media; `widget-sandbox.ts`: the widget sandbox page, its CSP and reserved messages; `tools.ts`: the Tools page catalog) |
| PI configuration | `server/api/pi.ts` and `server/api/providers.ts` (public configuration, model catalog, resource and provider payloads), `server/api/tools.ts` (global catalogs and session tool inspection), `server/api/session-events.ts` (runtime catalogs and model, thinking and side-question actions), `server/pi/` (`config.ts`: read-only view; `mutations.ts`, `paths.ts`, `resource-reader.ts`, `providers.ts`, `provider-*.ts`, `model-routing.ts`, `bundled-skills.ts`, `source-label.ts`), `routes/pi.ts` (`/__hui/pi…`, `/__hui/tools`), `routes/providers.ts` |
| Git and GitHub | `server/git/` (`worktrees.ts`: checkouts and worktrees for new sessions, cleanup eligibility and acknowledged risks; `branch-names.ts`: branch naming; `worktree-inventory.ts`: the Worktrees page, with `routes/worktrees.ts`; `working-directories.ts`: resolving and completing the paths the operator types), `routes/local-paths.ts` (directory and path completion, Git checkout lookup, with payloads in `server/api/local-paths.ts`), `server/integrations/` (`github*.ts`, `pull-requests.ts`, `github-links.ts`: gateway link parsing), `server/api/github.ts` (GitHub, pull-request and session-activity payloads) |
| Diff view | `server/git/diff.ts` (read-only Git comparisons: previous and default branch detection, patches with caps, untracked files through a temporary index), `routes/diff.ts` (`/__hui/sessions/:id/diff…`); payloads in `server/api/diff.ts`; browser comparison guards in `src/lib/diff/view-state.ts` |
| Integrations | `server/integrations/jira*.ts` with `server/api/jira.ts` (public work items, connection and draft payloads), `backlog.ts` with `routes/backlog.ts` (Kanban), `automation.ts` with `routes/automation.ts` (payloads in `server/api/automation.ts`), `server/integrations/` (`datadog.ts`: Datadog orgs through `pup`; `datadog-previews.ts`: chat cards for Datadog links; `datadog-links.ts`: link parsing), public payloads in `server/api/datadog.ts` |
| Terminals and browser | `server/terminals/` (`terminals.ts`; `replay.ts`: bounded replay bytes; `transport.ts`: JSON control payloads in `server/api/terminals.ts`, byte layout in `docs/api.md`) with `routes/terminals.ts` (`/__hui/sessions/:id/terminals…`), `server/browser/` (managed Chromium over a CDP pipe) with `routes/browser.ts` (`/__hui/browser…`, a pane's connect ticket), `server/browser/transport.ts` (tickets, streaming and the binary frame encoder), `server/api/browser.ts` (status and JSON controls); browser decoders in `src/api/browser.ts`, normalization in `src/lib/browser-status.ts` |
| Files view | `files.ts` (list, search, read, save, upload, delete inside a working directory; which chat paths exist there), `routes/files.ts` (`/__hui/sessions/:id/files…`), `server/api/files.ts` (JSON payloads); browser path helpers in `src/api/files.ts` |
| VS Code view | `server/vscode/` (`vscode.ts`: running the shared VS Code server, license consent, tickets and cookie secrets; `providers.ts`: finding VS Code desktop's `code serve-web`, servers on PATH or a configured path; launch flags; `install.ts`: the pinned, checksum-verified openvscode-server install on Linux; `proxy.ts`: the cookie-guarded HTTP and WebSocket proxy under `/__hui/vscode/`; `contract.ts`: server-only paths, actions and theme normalization), `routes/vscode.ts` (a view's connect ticket, `/__hui/vscode-server` status and actions); payloads in `server/api/vscode.ts`, browser links and labels in `src/lib/vscode.ts` |
| Bots and calls | `server/bots/` (`bots.ts`; `service.ts`, `conversations.ts`, `memory.ts`, `souls.ts`, `skills.ts`, `remote.ts`, `routines.ts`, `triggers*.ts`; `facts.ts`: explicit operator knowledge on the bot's host; `export.ts`: a bot as a template, reviewed for personal information; `export-format.ts`: `bot.json` and building the export, copied by `src/lib/bots/export-preview.ts`; `template-import.ts`; `calls.ts`, `call-helper.ts`; `voice-languages.ts`: the languages a bot speaks on calls, copied by `src/lib/voice/languages.ts`; `durable.ts`, `durable-access.ts`, `durable-routines.ts`, `durable-triggers.ts`: the bots' Durable extension, reached by the core only through `configureDurableBots`), `server/bots/templates/` (other platforms' bot templates, read for import, and the export's cleanup and reviewer; `formats.ts`: the template formats and limits), `server/api/bot-templates.ts` (import and export payloads), `server/api/calls.ts` (call payloads), `server/bots-format.ts` (records, limits, faces, kickoff and tags, copied for the browser by `src/lib/bots/bots.ts`) and `server/calls-format.ts` (call limits, voices and records, copied by `src/lib/voice/calls.ts`), which transcripts and the runtimes also read |
| OptChat memory | `optchat/` (engine, no HUI imports), `runtimes/durable-optchat.ts` (Durable glue); see `docs/optchat.md` |
| Remote workers | `workers.ts`, `routes/workers.ts` (gateway side), `worker/` (host daemon, protocol, bootstrap, config sync; `workers.ts`: Node command parsing and view types), `server/api/workers.ts` (public worker payloads) |
| Settings, paths, updates | `server/api/settings.ts` (public settings payloads), `hui-settings.ts` (server settings defaults, normalization and persistence) with `routes/settings.ts`, `themes.ts` (built-in and user themes, tweakcn import, token mapping and contrast math) with `routes/themes.ts` (`server/api/themes.ts`: theme list, import and JSON file payloads), `paths.ts`, `updates.ts` with `routes/updates.ts` (`server/api/updates.ts`: public payloads, `cli/releases.ts`: Node type owner and check interval), `power.ts` with `routes/power.ts` |

## src/ — the browser app

| Area | Start here |
|---|---|
| App shell | `main.ts` (styles, boot, mount), `lib/boot-screen.ts` (index.html's boot screen), `lib/view-assets.ts` (view stylesheets loaded together before the first paint), `hui-app.ts` (route, layout and the controllers' wiring), `src/lit/hui-element.ts` |
| Client stores and API | `src/api/` (requests to `/__hui/`: `request.ts` (fetch boundary, `x-hui` header, response deadline), `settings.ts`, `ui-errors.ts` (browser errors batched to the gateway), `sessions.ts` (session API), `session-list.ts` (applies session-list update frames), `terminals.ts`, `browser.ts`, `files.ts`, `diff.ts`, and one client per area: `automation.ts`, `backlog.ts`, `bots.ts`, `bot-facts.ts`, `bot-templates.ts`, `bot-tools.ts`, `bot-triggers.ts`, `calls.ts`, `datadog.ts`, `jira.ts`, `github.ts`, `github-previews.ts`, `pi.ts`, `providers.ts`, `themes.ts`, `vscode.ts`, `workers.ts`, …), `src/lib/settings/settings-store.ts` (settings cache and write queue), other `lib/*-store.ts` |
| Generated API types | `src/api/schema/`, generated only from `docs/api.schema.json` by `npm run api:schema` |
| Controllers | `src/controllers/` (Lit controllers holding a feature's state and calling `src/api/`): `conversation-controller.ts` (the open session's transcript, stream, models and question), `composer-controller.ts` (drafts, completion, the queue and sending), `sessions-controller.ts` (the session registry, the sidebar and the shell toasts), `launch-controller.ts` (New Session), `work-layout-controller.ts` (split panes and the Work pane), `backlog-controller.ts` (the Kanban board, its Jira dialogs and task suggestions), `settings-controller.ts` (HUI settings, theme, PI and the control surfaces), `automation-controller.ts`, `update-controller.ts`, `bots-controller.ts` and the bot `import`, `tools`, `triggers` and `facts` controllers, `voice-controller.ts` (calls), `browser-view-controller.ts` (the browser live view) |
| Pure logic | `lib/` (normalizers, parsers, layout and menu rules; tested beside each file), `lib/markdown/github-links.ts` and `lib/markdown/datadog-links.ts` (browser-local Markdown link detection; portable JSON fixtures match the gateway copies), `lib/jira.ts` and `lib/pull-requests.ts` (work-item and pull-request labels), `lib/widgets.ts` (widget documents, theme bridge and frame messages; CSP fixtures match the gateway copy) |
| Chat | `views/chat/` (projection, tool cards, position rail), `src/lib/markdown/`, `src/lib/composer/` (drafts, state, textarea, send requests); file references that open in the Files view: `lib/files/references.ts` (which text is a path), `lib/files/file-link-store.ts` (batched, cached existence checks), `components/file-link.ts` (`<hui-file-ref>`) |
| Sidebar and sessions | `src/lib/session/sidebar-sessions.ts`, `lib/session/sessions.ts` (group labels, transcript Markdown, unreachable hosts), `lib/session/tree.ts`, `views/sessions.ts`, `views/sidebar-session-options.ts` |
| Pages | `views/*.ts` (settings, automation, kanban, bots, worktrees); self-loading settings sections in `src/components/settings/`, `components/contributions.ts`, `components/session-calendar.ts`; the bots pages' parsers and state in `src/lib/bots/`, voice and live calls in `src/lib/voice/` |
| Reusable components | `components/` (panes, hovercards, dialogs); `components/openclaw/` is a hash-pinned OpenClaw port, do not edit it by hand |
| Split chats and the Work pane | `lib/session/multiplexer.ts` + `components/session-multiplexer.ts` (chat columns, stacks, tabs), `views/session-pane.ts` (one chat pane); `lib/work-pane.ts` (Work view registry and contract, browser-local per-conversation state, migration of old terminal/browser panes), `components/work-pane.ts` (tab strip, launchers, collapsed rail, maximized presentation, narrow destination), `lib/work-shortcuts.ts` (the Work pane's shortcut table and the chords it avoids), `views/panel-selector.ts` (narrow destination chooser, also above a maximized Work pane) |
| Shared terminal | `components/terminal-pane.ts` (Gespenst view: socket, replay, input, links, clipboard, touch, key bar); `src/lib/terminal/` (`stream.ts`: wire reader; `fit.ts`: hidden-pane fits, PTY resize, prompt reflow; `theme.ts`, `links.ts`, `keys.ts`: key bar, clipboard keys; `touch.ts`), `lib/terminal/font.ts` (faces for the worker); Vite settings for Gespenst in `server/vite-plugin.ts` (`huiConfig`) |
| Work views | `src/views/work/` (one kind per Work pane view: launch, title, render — terminal, browser, files, vscode, diff), `components/files-view.ts` with `api/files.ts` and `src/lib/files/` (`draft.ts`, `editor.ts`: CodeMirror, loaded on demand; `view-state.ts`); `components/vscode-view.ts` through `lib/vscode-store.ts`, with HUI's colors for it read by `lib/theme/vscode-theme.ts`; `components/diff-view.ts` with `api/diff.ts` and `src/lib/diff/` (`view-state.ts`, `hunks.ts`: patch parsing, side-by-side rows; `highlight.ts`: syntax colours through `lib/code-languages.ts`, shared with the Files editor) |
| Visual tokens | `styles/tokens.css` first, then the per-surface stylesheets; themes through `src/lib/theme/theme-store.ts` (loading through `api/themes.ts`, user accent) and `lib/theme/shadcn-theme.ts` (token mapping, contrast rules), with color math in `lib/theme/color-contrast.ts` |

## Elsewhere

| Path | Owns |
|---|---|
| `cli/` | The `hui` command: gateway lifecycle (`gateway*.ts`, `state.ts`), installed releases and updates (`releases.ts`, `update*.ts`, `installation.ts`), `hui doctor` (`doctor*.ts`), the `/__hui/` client of `hui bot` and `hui schedule` (`gateway-client.ts`) |
| `desktop/` | Electron wrapper (`main.cjs`, `policy.cjs`) and macOS app registration (`install.mjs`) |
| `bin/` | Entry points: `hui.mjs` (installed CLI), `hui-dev.mjs` (`npm run dev`) |
| `scripts/` | Build, release and nightly versioning |
| `e2e/` | Browser-tool E2E procedures (`*.browser.md`), the launcher (`visual-verification.mjs`) and the package test; `e2e/fixtures/` (fake providers, CLIs and services, seeds and PI extensions the launcher and tests start), `e2e/probes/` (in-page probes and oracles a procedure loads into the running app) |
| `nix/` | Flake package, NixOS module and smoke checks |
| `skills/` | Skills shipped with HUI |
| `themes/`, `public/` | Theme palettes and static assets |

## Conventions that keep this map short

- Every source module begins with a header comment: what it owns and, when it
  helps, what it deliberately leaves to someone else. A test enforces that the
  header exists (`scripts/module-headers.test.mjs`); keeping it true is the
  editor's job.
- Tests sit beside their owner as `*.test.ts`; helpers that several server tests share
  (bounded waits, log readers) live in `server/test-support/`, which the build leaves out.
- When you add a source directory, name it here; the same test checks that
  every directory holding source modules appears in this file by its full
  path (`server/browser/`, not `browser/`).
