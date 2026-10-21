# GitHub embeds browser verification

Verified on 2026-09-25 with the OpenClaw Browser tool against the real HUI
gateway (Vite, port 5198), real PI 0.87.1 transcripts and the fake GitHub CLI
(`e2e/fixtures/github-cli-fixture.mjs`, canned `gh api` payloads; since 2026-10-17
`gh api graphql` answers). No operator GitHub
login, transcript or HUI registry was read or changed.

## Reproduce

1. `R=$(mktemp -d /tmp/hui-github-embeds-XXXX)` and
   `node e2e/fixtures/github-embeds-fixture.mjs $R node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js`.
   It seeds one session (*Checkout PR*): thirty earlier turns that each link a
   pull request, an issue and a Slack thread, then a user message that links
   issue `acme/web#7`, a bash tool that ran `gh pr create` printing
   `acme/web/pull/12`, and a final assistant message that mentions five
   references, one inside code.
2. Start Vite with `XDG_CONFIG_HOME=$R/xdg`, `PI_CODING_AGENT_DIR=$R/pi-agent`,
   `PI_CODING_AGENT_SESSION_DIR=$R/pi-sessions`,
   `HUI_GITHUB_CLI=$PWD/e2e/fixtures/github-cli-fixture.mjs`, `HUI_FAKE_GH_DIR=$R/gh` and
   `NO_PROXY=127.0.0.1,localhost`.
3. Open `/sessions/github-embeds` at 1440×900, then 390×844.

## Observed

- The user message showed one card: **acme/web#7 · Closed** (completed icon),
  title, body snippet, author `lana`, labels `bug`/`mobile`, 4 comments.
- The assistant message showed exactly three cards in reading order:
  **acme/web#12 · Open** (green edge, +120 −34, 5 files, 3 comments),
  **acme/web#13 · Merged** (the `acme/web#13` shorthand resolved through the
  issues endpoint to the merged pull request, purple edge), and the **acme/web**
  repository card (Private, TypeScript, ★ 1.3k, 97 forks). The code-quoted
  `…/pull/99` and the fifth link `acme/missing` were not unfurled. Every card is
  an anchor to the item on GitHub with `target="_blank"`.
- The sidebar PR badge for `acme/web#12` turned **open** with the fixture title,
  confirming badges now use the same `gh api` previews instead of `gh pr view`.
- The previews route returned `not_found` for an unknown repository,
  `signed_out` when the fake account was removed, and 400 for a non-GitHub URL.
- At 390×844 the cards were 374 px (295 px inside the user bubble) with no
  horizontal overflow (`scrollWidth` 390).

## Hover and opt-out (2026-09-25 follow-up)

- Hovering the `acme/web#12` card opened the PR hovercard below it (340 px,
  `data-state="open"`) with the state pill, title and the full Markdown body,
  including the `Details` heading that the card snippet omits.
- Settings → Appearance → Chat listed *GitHub link previews* (on by default).
  Turning it off saved `chat.githubEmbeds: false`; reopening the session showed
  both messages with no `hui-github-embeds` element and no cards, while the
  sidebar PR badge stayed *open*.

## Proof gap

Previews were served by the fake CLI; the real `gh api` payload shapes were
checked against `repos/cli/cli`, `…/pulls/14517` and `…/issues/14517` and are
covered by `server/integrations/github-previews.test.ts`. Streaming unfurl (800 ms settle)
is covered by code review, not a live streaming turn.

## Latest messages only, one `gh` call (2026-10-17)

Same fixture with the thirty earlier turns, served by the built gateway
(`node bin/hui.mjs gateway run --port 43391`, the environment of step 2, with
`HUI_GITHUB_CLI` pointing at a wrapper that logs each `gh` invocation before
running the fake) and the deterministic provider (`e2e/fixtures/pi-provider-fixture.mjs`,
its URL written into `pi-agent/models.json`), checked with the Browser tool at
1440×900 and 390×844.

- Opening the session unfurled only the latest user message (the `acme/web#7`
  card) and the final reply (`#12`, `#13`, `acme/web`). The sixty earlier
  messages kept their GitHub links and the Slack permalink as plain links, with
  no card.
- The fake `gh` ran once for previews: `gh/preview-log` held one line,
  `acme/web#7 acme/web#12 acme/web#13 acme/web`, the PR badge's lookup included.
  The same seed on `main` ran 65 `gh api` processes, one or two per link.
- Sending *Rebase https://github.com/acme/web/pull/13 onto main next.* moved
  the cards: the new message showed `#13`, while the `#7` message and the
  previous reply kept plain links; the fixture's reply has no link and no card.
- The only later lookup was `acme/web#12`, the open PR badge's 60-second
  refresh: the new message's `/pull/13` shares the cached `acme/web#13`.
- Against the real `gh` 2.100.0, the gateway's query previewed seven `cli/cli`
  links (a repository, merged pull requests, an issue, a pull URL that names an
  issue and two missing items) in one call; a 25-item query costs one GraphQL
  rate-limit point.

## Two GitHub accounts (2026-10-17)

The same seed with the fake `gh` signed in to two accounts (`gh/accounts` holds
`hui-e2e`, the active one, and `hui-e2e-personal`) and `gh/previews.json`
making issue `acme/web#7` visible to `hui-e2e-personal` only (`"_account"`).
Opening the session at 1440×900 and 390×844 showed the `#7` card filled in
(*Closed*, its labels and 4 comments). `gh/preview-log` held
`hui-e2e: acme/web#7 acme/web#12 acme/web#13 acme/web`, then
`hui-e2e-personal: acme/web#7`, and the wrapper logged one `gh auth status` and
one `gh auth token --user hui-e2e-personal` between the two queries. Against the
real `gh`, a private repository of the second signed-in account that the active
account cannot see previewed the same way.
