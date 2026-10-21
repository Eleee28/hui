# Kanban board

Verified on 2026-09-25 with the OpenClaw Browser tool against the Vite gateway
(`localhost:5188`) and a disposable root (`XDG_CONFIG_HOME`, `PI_CODING_AGENT_DIR`,
`PI_CODING_AGENT_SESSION_DIR` under `/tmp`, `PI_OFFLINE=1`), headless Chromium
on CDP 18800. No operator registry or transcript was touched.

## Fixture

`xdg/hui/sessions.json` version 2, no groups, eight records across three
directories (`web`, `api`, `docs`): agent stages investigation, implementation,
testing and done; one operator implementation placement with an icon; two
unstaged (Backlog); one unread; one archived Done session.

## Journeys and observed results

1. Sidebar shows **Kanban** directly below Contributions; clicking it opens
   `/kanban` with five columns and per-column counts, lanes API, DOCS, WEB with
   their paths. The archived session is absent. The unread session shows
   status **Done**.
2. Card stage menu → **Testing**: status note "Moved … to Testing.", the card
   renders in Testing and keeps focus. **Let the agent decide** is disabled for
   an agent-placed card.
3. Shift+ArrowRight on the focused title moves it to Done.
4. Dragging "Write release notes" from DOCS/Backlog onto DOCS/Investigation
   moves it; `sessions.json` records `stage: "investigation"`,
   `stageSource: "operator"` for the three moved cards.
5. **View** menu lists Group by, Sort by, Status, Columns, subagents, Hide empty
   lanes and Reset view. **Custom groups** replaces project lanes with OTHER and
   survives a reload; **Reset view** restores project lanes.
6. No page errors or console errors. Narrow (mobile) viewport: header and View
   controls wrap, the board scrolls horizontally.

Proof gap: `set_stage` from a live agent turn and pull-request inference are
covered by server/unit tests only, not by this Browser journey.

## Backlog start dialog (2026-09-26)

Isolated root under `/tmp` (`XDG_CONFIG_HOME`, `PI_CODING_AGENT_DIR`,
`PI_CODING_AGENT_SESSION_DIR`, `PI_OFFLINE=1`), `HUI_JIRA_TEST_ORIGIN` pointing to
a local fake Jira with CI-2 and CI-3 (CI-3's summary contains `E2E_HOLD_BRANCH`),
`e2e/fixtures/pi-provider-fixture.mjs` as `hui-e2e/primary-fixture` and
`hui-e2e/utility-fixture`, HUI settings `branchPrefix: "feature/"` and that
utility model, a temp Git repo (`main`, `dev`, `release/1.0`) and a plain folder.
The fixture answers the worktree-name prompt with
`feature/CI-2-fix-rate-limit-jira-proxy`; for `E2E_HOLD_BRANCH` it waits for
`POST /control/release-replay`.

1. Clicking the CI-2 title opens the dialog with only the folder field; Start
   is disabled.
2. The plain folder shows "Not a Git repository; …" and nothing else; Start is
   enabled.
3. The repo shows Branch / New worktree with neither checked; Start disabled.
   The utility-model request is already in the provider log.
4. Branch shows one field (`main`) and enables Start. New worktree shows the
   model suggestion normalized to `rate-limit-jira-proxy`, the hint
   `feature/rate-limit-jira-proxy` and **From** `main`. Renaming it to
   `throttle-jira-calls` and starting creates branch
   `feature/throttle-jira-calls` in a managed worktree and links CI-2.
5. CI-3 → repo → New worktree shows "Suggesting a name…" with the spinner while
   the suggestion is held; typing `backlog-file-docs` and then releasing it
   keeps the typed name (the suggestion only becomes the placeholder).
6. Switching to the plain folder removes the later steps; switching back shows
   the choice unchecked again. Branch → `dev` → Start switches the repo to
   `dev` and starts the session there.
7. 390×844: no horizontal overflow. No console or page errors.

## Shared backlog branch selection regression (2026-09-27)

This journey supersedes the unchecked-mode and separate From-field expectations
in the historical 2026-09-26 run above. Use the repository visual-verification
launcher with real PI and its local deterministic provider. Seed a synthetic
local backlog task in the isolated HUI config, plus a disposable repository with
current branch `feature/demo`, local `main` and `release/1.0`, and `origin/HEAD`
pointing to `origin/main`. Keep another disposable non-Git folder available.

1. Open the task from Kanban. Once inspection settles, Branch is checked, the
   shared Branch picker says `main`, Start is enabled, and Branch suffix is absent.
2. Search/select `release/1.0` using the shared picker and keyboard. Switch to
   New worktree: the ref stays `release/1.0` and Branch suffix appears. Edit the
   suffix, toggle back to Branch and back: the ref and suffix are retained;
   Branch hides the suffix. The picker remains usable in either mode.
3. Change to the plain folder: no Git controls. Return to the repository:
   Branch and `main` are restored, with no suffix field.
4. Start in Branch without overriding `main`; verify the session starts in the
   selected checkout and Git is now on `main`. With a second synthetic item,
   choose New worktree and a different base and suffix; verify the new checkout
   uses the prefixed suffix and starts at the selected base commit.
5. Repeat the selector/toggle interactions at 1440×900, 390×844 and 844×390;
   inspect the resulting screen and page/console errors. Capture Branch and
   Worktree states outside Git and attach to the PR and conversation.
