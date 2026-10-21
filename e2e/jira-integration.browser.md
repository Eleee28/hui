# Jira integration browser verification

Verified on 2026-09-25 with the OpenClaw Browser tool against the real HUI
gateway (Vite, port 5197), real PI 0.87.1 and two local fixtures: the
deterministic Anthropic-protocol provider (`e2e/fixtures/pi-provider-fixture.mjs`, also
the utility model) and a Jira Cloud REST v3 subset (`e2e/fixtures/jira-fixture.mjs`).
No Atlassian account, operator transcript or operator credential was used.

## Reproduce

1. Create a fresh `/tmp/hui-jira-e2e-*` root with `workspace`, `pi-agent`,
   `pi-sessions`, `xdg/hui` and `browser`. Configure one `hui-e2e/fixture`
   model in `pi-agent/models.json` pointing at `http://127.0.0.1:43127`, and seed
   `xdg/hui/settings.json` with `models.primary` and `models.utility` set to it.
2. Seed `xdg/hui/sessions.json` with three sessions in group `CI`: *Pipeline
   reliability audit* (`jiraIssues: [{ key: "CI-1", url: "http://127.0.0.1:43128/browse/CI-1" }]`),
   *Flaky CI retries* and *Docs cleanup*.
3. Start `HUI_E2E_PROVIDER_PORT=43127 … node e2e/fixtures/pi-provider-fixture.mjs`,
   `HUI_E2E_JIRA_PORT=43128 node e2e/fixtures/jira-fixture.mjs`, and Vite with
   `XDG_CONFIG_HOME`, `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`
   under the root plus `HUI_JIRA_TEST_ORIGIN=http://127.0.0.1:43128`. Set
   `NO_PROXY=127.0.0.1,localhost` when an HTTP proxy is configured.
4. Drive an owned headless browser (profile under the root) at 1440×900, then
   390×844.

## Observed

- **Settings → Integrations** (Connections group) listed Jira as its first section, which showed the three API-token steps
  with a link to `id.atlassian.com`. Filling site, email and token and pressing
  *Connect Jira* showed "Connected as HUI E2E." and the account row. Choosing
  *CI Platform (CI)* as the default project showed "New work items default to
  CI." `GET /__hui/jira` and the page DOM never contained the token;
  `jira.json` was written with mode 600.
- **Row mark**: *Pipeline reliability audit* showed the Jira mark left of its
  title, blue for `In Progress` (`data-state="indeterminate"`). The session
  link's accessible name ended with `Jira CI-1, in progress: Pipeline reliability`.
- **Hovercard**: hovering the mark opened a card below it with `CI-1 · Epic`,
  an **In Progress** pill, the summary and the ADF description rendered as
  Markdown (headings, list, inline code). The body scrolled internally
  (`scrollTop` 150) without the card closing.
- Clicking the mark called `window.open("…/browse/CI-1", "_blank",
  "noopener,noreferrer")` and did not select the session.
- **Create**: the session menu of *Flaky CI retries* → *Create Jira work
  item…* opened the dialog with *CI Platform (CI)* preselected, parent
  `CI-1 · Pipeline reliability` marked *suggested*, and summary and Markdown
  description drafted by `hui-e2e/fixture`. *Create* closed the dialog, showed
  "Created Jira work item CI-41." and the row gained a `CI-41` mark (To Do).
  The fixture received project `CI`, issue type `12` (Task), parent `CI-1` and
  an ADF `doc` (heading, paragraph, heading, bulletList, heading, bulletList).
  `sessions.json` gained only `{ key, url }` for that session.
- At 390×844 the drawer rows showed the marks left of the titles. The dialog
  was 342px wide with no horizontal overflow. Editing the summary, then
  switching to *Operations (OPS)*, reset the parent to *No parent* (no OPS
  epic fits), kept the edited summary, and created `OPS-42`.
- The first run surfaced an `InvalidStateError` (`showModal` on a detached
  dialog after Create). After the fix, a second create produced no page errors.

## Large sites (2026-09-25 follow-up)

The fixture now lists 600 filler projects before `CI` and `OPS`. Settings
showed "602 projects; type to search them all." Typing `operat` in the
default-project search returned `Operations (OPS)` from Jira's search;
selecting it saved `OPS` and it stayed selected after a reload. In the create
dialog OPS was preselected and typing `ci plat` found `CI Platform (CI)`.
No page errors.

## Link existing work item (2026-09-25 follow-up)

The session menu lists *Link Jira work item…* after *Create Jira work item…*.
Opening it on *Flaky CI retries* focused the search and listed **Recently
viewed** (`issue in issueHistory()`): OPS-1, CI-2 and CI-1. Typing `tooling`
showed **Results** with only `CI-2`; Enter linked it, closed the dialog, showed
"Linked Jira work item CI-2." and the row mark became CI-2 (accessible name
"…, 1 more linked"). At 390×844 the dialog was 342px wide with no horizontal
overflow; pasting `…/browse/CI-1` resolved exactly CI-1 and a click linked it.
Items already linked to a session are not offered again. No page errors.

## Assignee and leading column (2026-09-25 follow-up)

With a connection saved before `accountId` was stored, *Create* (with the new
*Assign to me* checkbox checked by default) created `OPS-41`; HUI learned the
account id from `/myself`, stored it in `jira.json` only (not in
`GET /__hui/jira`) and the fixture recorded `assignee: e2e-account`.
The Jira mark now renders in the leading status column: the parent's mark
centre (x=29) equals its indicator column, the same column child status glyphs
use one tree level deeper, and no mark remains in the title row.

## Proof gap

The managed headless Brave reports `(hover: none)`; the hover was driven by
the Browser tool's pointer, which the controller accepts per pointer type.
Real Jira Cloud was not contacted: the REST shapes follow Atlassian's v3
documentation and are exercised by the fixture and `server/integrations/jira.test.ts`.
