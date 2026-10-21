# Suggested tasks browser verification

Verified on 2026-09-25 with the OpenClaw Browser tool against the real HUI
gateway (Vite, port 5311), real PI and two local fixtures: the deterministic
Anthropic-protocol provider (`e2e/fixtures/pi-provider-fixture.mjs`, also the utility
model) and the Jira REST v3 subset (`e2e/fixtures/jira-fixture.mjs`, port 43332). No
operator transcript, credential or Atlassian account was used.

## Reproduce

1. Create a fresh `/tmp/hui-suggest-e2e-*` root with `workspace`, `agent`,
   `sessions`, `xdg/hui` and `browser`. Configure `hui-e2e/fixture` in
   `agent/models.json` pointing at `http://127.0.0.1:43331`, and seed
   `xdg/hui/settings.json` with `models.primary` and `models.utility` set to it.
2. Seed `xdg/hui/sessions.json` with one session *Terminal polish* (group `HUI`,
   `cwd` = the workspace) and `xdg/hui/jira.json` (mode 600) for site
   `http://127.0.0.1:43332`, `e2e@hui.test` / `e2e-token`, default project `CI`.
3. Start the provider (`HUI_E2E_PROVIDER_PORT=43331`), the Jira fixture
   (`HUI_E2E_JIRA_PORT=43332`) and Vite with `HOME`, `XDG_CONFIG_HOME`,
   `PI_CODING_AGENT_DIR`, `PI_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR` under the
   root, `PI_OFFLINE=1`, `HUI_JIRA_TEST_ORIGIN=http://127.0.0.1:43332`, and HTTP
   proxy variables unset (`NO_PROXY=127.0.0.1,localhost`).
4. Drive a browser at 1440×900, then 390×844.

## Observed

- Sending `E2E_SUGGEST_TASK` made the fixture call `suggest_task` twice. A
  *Suggested task · in workspace* card appeared in the transcript's top-right
  gutter (450px wide), stacked with `1/2`, newest first (*Document the
  suggest_task lifecycle*). The raw tool calls stayed in the activity
  disclosure. A page reload kept both cards (gateway memory).
- *Next suggestion* showed `2/2` (*Replace native terminal switcher…*);
  *Show instructions* revealed the directory and the self-contained prompt.
- *Create Jira task* opened the Jira dialog: "From a suggested task · linked
  to “Terminal polish”", project CI, summary = card title, description = tldr +
  `## Instructions` + prompt, parent `CI-1` marked *suggested* by the utility
  model. *Create* closed it, showed "Created Jira work item CI-41." and removed
  that card. The fixture received CI-41 with parent CI-1 and an ADF
  paragraph/heading/paragraph built from the card.
- *Start in a new session* on the remaining card created and opened
  *Document the suggest_task lifecycle* in group HUI with the card's prompt as
  its first user turn (fixture replied). Returning to *Terminal polish* after a
  reload showed no cards.
- A second `E2E_SUGGEST_TASK` turn produced two new cards; *Dismiss
  suggestion* removed the shown one and the stack counter disappeared.
- At 390×844 the card spanned 18–372px, both actions fit on one row and the
  page had no horizontal overflow. No page errors.

## Problem / proposed fix format (2026-09-25 follow-up)

Cards now carry `problem` and optional `fix` instead of an instruction prompt.
With the updated fixture, *Show details* rendered Markdown **Problem** and
**Proposed fix** sections (inline code as chips); the second card, recorded
without `fix`, showed *Proposed fix — Not known yet.* *Create Jira task* on it
prefilled only `## Problem`, and the fixture received that ADF plus parent
CI-1 and assignee. *Start in a new session* on the first card sent
`# <title>`, `## Problem` and `## Proposed fix` as the first user turn. At
390×844 the expanded card spanned 18–372px with no horizontal overflow and no
page errors.

## Start menu (2026-09-25 follow-up)

As in OpenClaw, the chevron beside *Start in a new session* opens *Start in a
new session*, *Start in a new worktree* and *Start in this session*. With the
workspace initialized as a Git repository: *Start in this session* sent
`# <title>` / `## Problem` / `## Proposed fix` as a new user turn in the same
conversation (no navigation) and removed the card. *Start in a new worktree*
created `feature/replace-native-terminal-switcher-select-with-hui` under HUI's
worktree root (`git worktree list` showed it), opened that session with the
card as its first turn, and removed the card. At 390×844 the menu stayed
inside the 18–372px card with no horizontal overflow; no page errors.
Menu items reuse the session-menu classes but match the card's own 12px
actions: 12px labels, 26px rows on desktop, 36px touch rows at 390×844.

## Proof gap

The managed browser profile exited mid-run (attach-only), so the remainder ran
in a headless Brave on the same CDP port. The gateway-restart drop of pending
cards is covered by design (in-memory store) and was not exercised in the
browser.
