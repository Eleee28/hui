# Sidebar groups and Filter & Sort

Verified on 2026-09-24 using the OpenClaw Browser tool against the running HUI
Vite service. All registry and PI data lived in a disposable temporary root.
The real PI runtime used the deterministic local provider, without operator
credentials or a paid model call.

## Fixture and reproduction

Create a temporary root (`HUI_GROUPS_RUN`) containing `xdg/hui`, `pi-agent`,
`pi-sessions`, `workspace`, `other-project` and `browser` directories.

Seed `xdg/hui/sessions.json` with version 2, an empty `groups` array and these
three synthetic records. All have `group: ""`, `tool: "pi"`, `source: "hui"`,
and timestamps in ISO format at 12:00 UTC on the listed dates:

| ID | Title | Directory under fixture root | Created | Updated | Pinned |
| --- | --- | --- | --- | --- | --- |
| pin | Pinned note | workspace | 2026-09-20 | 2026-09-20 | true |
| alpha | Alpha recently created | other-project | 2026-09-23 | 2026-09-21 | false |
| zulu | Zulu recently updated | workspace | 2026-09-21 | 2026-09-24 | false |

Seed HUI settings with `theme: "catppuccin"` and use Browser color-scheme
emulation. Set up the local Anthropic-compatible model as described in
[session-launch.browser.md](session-launch.browser.md), using port 43157,
provider `hui-e2e`, model ID `fixture` and name `Local fixture`. Point PI's
default provider/model to this fixture and keep packages/extensions/skills empty.
The API key is only the literal fixture marker, not an operator credential.

Start the provider and gateway in separate terminals from the checkout, with
an environment stripped of provider credentials (retain PATH/HOME/USER/LANG):

```sh
HUI_E2E_PROVIDER_PORT=43157 \
HUI_E2E_WORKSPACE="$HUI_GROUPS_RUN/workspace" \
HUI_E2E_PROVIDER_LOG="$HUI_GROUPS_RUN/provider.jsonl" \
node e2e/fixtures/pi-provider-fixture.mjs

XDG_CONFIG_HOME="$HUI_GROUPS_RUN/xdg" \
PI_CODING_AGENT_DIR="$HUI_GROUPS_RUN/pi-agent" \
PI_CODING_AGENT_SESSION_DIR="$HUI_GROUPS_RUN/pi-sessions" \
PI_OFFLINE=1 NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1 \
node --input-type=module -e 'import {createServer} from "vite"; const server=await createServer({server:{hmr:false,host:"127.0.0.1",port:5188,strictPort:true}}); await server.listen(); server.printUrls();'
```

Use an owned headless Chromium profile under the fixture root, with CDP on
18800, and navigate via Browser to `http://localhost:5188/`. Stop only owned
provider/gateway/browser/PI processes afterwards; leave fixture data available
for inspection. No operator registry or transcripts are modified.

## Browser journeys and observed results

1. With **only OTHER** visible, click the Sessions toolbar's **New group** button.
   The existing modal focuses Group name. Create `Research Lab`; **RESEARCH LAB**
   appears immediately, above OTHER, with count 0. Focus returns to New group.
2. Open **Filter & sort**, select **Created** and observe `Pinned note`,
   `Alpha recently created`, `Zulu recently updated`. Reload: the group and sort
   preference both survive. Select **Last updated** and the two unpinned rows
   reverse; the pin stays first. **Name** also places Alpha before Zulu.
3. Select **Project**: sessions split into OTHER-PROJECT and WORKSPACE, with no
   custom-group mutation menus. Click **New session in OTHER-PROJECT**: the real
   launch form selects that fixture directory and the OTHER group (empty raw
   group value). Select **None**: group headings disappear and all rows sort
   together.
4. Choose **Error** with no failed sessions: the sidebar announces **No matching
   sessions.** New group remains reachable. Create `Sprint Notes` using Enter:
   custom grouping and All status return, the new empty group is visible, and
   the selected Name sort is preserved.
5. Click **New session in RESEARCH LAB**, enter the disposable workspace and
   `Ping`, then Start session. HUI creates the session, PI starts, and the chat
   receives **Fixture response.** The sidebar count becomes 1. Read-only fixture
   inspection confirms raw group `Research Lab` and unchanged registry version 2.
6. Click **Search sessions** and enter `other`: only OTHER and its three rows
   remain. Clearing search restores the custom groups and rows. (Since
   2026-10-06 the desktop header has no Search button: use the mobile top bar's
   Search, or Tab to the field below the header.)
7. On iPhone 13 emulation (390×664 CSS px, DPR 3), open navigation and the menu.
   **End** scrolls the last option, Never, into view; Enter applies it. Escape
   closes the menu, returns focus to Filter & sort and leaves the drawer modal.
8. From the mobile drawer, create `Mobile Ideas`. The drawer closes before the
   modal opens; the dialog fits x=12…378. On success focus returns to Open
   navigation and main is no longer inert. Reopen: **MOBILE IDEAS** is visible.
9. Select **Hide empty groups → Always** using End/ArrowUp/Enter: only RESEARCH
   LAB and OTHER remain. Select **When filtering**: both empty groups return.
10. Repeat the menu inspection at 844×390 landscape; the menu flips above the
    trigger, remains in bounds and scrolls. Resize the open drawer to desktop:
    the drawer state clears and main is not left inert. Desktop menu selection
    also works with Home/ArrowDown/Enter.

The portrait menu measured x=40…264, y=225…654 with scrollable content (737 px
content, 427 px client height). Landscape measured x=232…456, y=10…187. There
was no horizontal overflow in the document, main, sidebar or menu. Screenshots
were visually inspected. Browser recorded **zero runtime errors and zero
error-level console messages**.

## Proof limits and checks

All five live status values, pin precedence, duplicate project-directory names,
invalid saved preferences, empty-group policies and source-data non-mutation
are covered by focused unit tests. The Browser journey verifies status-filter
interaction and its no-match state; it does not fabricate every live status.
Project grouping is by exact directory, not inferred Git-repository identity.
Owners, archival state, message previews and system-session classifications are
not exposed because this registry does not supply them.

- `npm test -- src/lib/session/sidebar-sessions.test.ts src/views/shell.test.ts src/views/home.test.ts src/views/sessions.test.ts`: 66 passed.
- `npm test`: 369 passed, no skips.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.


## Group Git defaults journey

Use `visual-verification.mjs` with a disposable repository on `feature/current`,
its `origin/HEAD` pointing to `main`, and a `release/1.0` branch at a distinct
commit. Create a group through the UI, then open **New session defaults**.

1. Select the fixture directory: Environment is Branch, Base branch is main.
2. Select New worktree and release/1.0; toggle Branch and back: the ref stays.
   Save and reload. Reopen defaults and verify both selections persisted.
3. Start a new session from the group: its checkout picker inherits both values.
   Enter a suffix and prompt; verify the isolated branch starts at release/1.0
   and the original checkout is unchanged.
4. Save Branch with main. Start another session from the group; verify it uses
   the original directory and checks out main. Existing sessions are not moved.
5. Change the defaults directory to a non-Git directory: Git selectors vanish.
   Save/reload and verify Git defaults are cleared; cancel leaves saved values
   untouched. Inspect desktop, portrait and landscape with keyboard-operated
   selectors, no clipping and no new page/console errors.
