# Direct session-menu mnemonics and archive recovery toast

Verified 2026-09-25 using Browser-tool keyboard input against the real HUI app at
`http://localhost:5200`, with disposable HUI/PI directories under
`/tmp/hui-menu-browser`. The fixture is the five-session tree from
`session-tree-lifecycle.browser.md`; no model calls or operator data are needed.

## Browser journey

1. Open Independent conversation at 1440x1000. Open **Actions for Plan website**
   and press native `a` with Browser `act:press`, without Enter. The menu closes,
   the parent and its three descendants leave the sidebar, and a toast reads
   `Archived “Plan website”.` with **Restore** and a dismiss control.
2. Focus Restore, capture the rendered desktop view, and press Enter. The toast
   disappears and all five session rows return. Registry flags confirm all four
   archived records are restored. Focus keeps the toast alive during inspection.
3. Reopen the parent menu for each native key: `p` sets pinned, `u` marks unread,
   `d` opens the existing destructive confirmation without deleting any record.
   Cancel with Escape; `r` opens the Session name/Session group editor. Cancel it
   with Escape. The letters activate actions rather than selecting menu items.
4. Reopen the menu and press `Shift+A`. The current parent archives and Home
   opens, retaining the recovery toast. Resize to 390x844 and inspect/capture
   the mobile toast; Restore and dismiss remain accessible.
5. For a controlled failure, replace only the next fixture restore PATCH response
   in page fetch with HTTP 503 and an explicit fixture error. Activate Restore
   with Enter. The toast retains an alert and an enabled Restore button; nothing
   is falsely reported as restored. Click Restore again, using the real endpoint,
   and verify all four registry flags return to false.
6. Archive once more without hovering/focusing the toast. Wait for its text to
   disappear as an observable condition (20-second timeout, no fixed sleep).
   The toast expires and the session tree remains archived.

Snapshots established controls before actions. Menu triggers were clicked through
Browser evaluate; the mnemonic and confirmation keys used actual Browser press
input. No direct HUI API mutation replaced the user journey. Browser page errors:
zero. Failure injection is intentionally synthetic; it does not indicate a
backend outage.

## Automated coverage

`src/lib/session/menu-shortcuts.test.ts` covers mappings, uppercase letters,
modified/repeated/composing input, capture-time activation, disabled/closed menus,
editable targets and nested submenu isolation. Existing menu structure and Escape
checks remain passing. No new dependencies or persisted formats were introduced;
the toast uses the existing archive/restore API and OpenClaw-derived toast CSS.

Validation: `npm test` (640 passed), `npm run typecheck`, `npm run build`, and
`git diff --check`. The build retains its existing large-chunk advisory.
