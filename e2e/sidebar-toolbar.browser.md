# Browser journey: sidebar header utilities

> Superseded on 2026-10-06: the owner dropped the header's New session and
> Search sessions buttons. The header now holds only **Collapse sidebar**, at its
> top-left, where **Expand sidebar** appears while the sidebar is collapsed. The
> search field below the header remains; the mobile top bar's Search opens it.
> See the latest section of e2e/bots.browser.md for that check.

Verified on 2026-09-24 in the running HUI app through the Browser tool.

## Reproduce

1. Create a fresh `/tmp/hui-sidebar-toolbar-*` root with `workspace`, `xdg/hui`,
   `pi-agent` and `pi-sessions` subdirectories. Put an empty `providers` object in
   `pi-agent/models.json`; no model calls or operator credentials are needed.
2. Seed `xdg/hui/sessions.json` with a version-2 registry containing three
   disposable `source: "hui"`, `tool: "pi"` sessions with valid timestamps and
   `cwd` pointing at that workspace: **Review chat layout** and **Miami
   appearance** in **Frontend**, and **Gateway reconnect** in **Runtime**.
   Include both custom groups. Do not attach operator transcripts.
3. Set `xdg/hui/settings.json` to `{"theme":"miami","themeMode":"dark"}`.
   Run `npm run dev` with `XDG_CONFIG_HOME=<ROOT>/xdg`,
   `PI_AGENT_DIR=<ROOT>/pi-agent`, `PI_CODING_AGENT_DIR=<ROOT>/pi-agent`,
   `PI_CODING_AGENT_SESSION_DIR=<ROOT>/pi-sessions` and `PI_OFFLINE=1`.
   This run used `http://localhost:5173` in a dedicated Browser-tool tab.
4. Check a **1440×960** desktop viewport, **390×844** mobile viewport and
   **844×390** short landscape. Mobile checks use iPhone touch emulation.

## Verified through visible controls

- Header order is **Search sessions**, **Settings**, **Collapse sidebar**,
  **New session**. Search and Settings form the left cluster, with existing
  actions on the right. The Sessions toolbar retains Filter & sort and New
  group. There is no duplicate search button there and no bottom Settings bar.
- Clicking Search focuses the expanded input directly below the fixed header,
  above Home. Typing `miami` leaves only **Miami appearance** in the session
  list; clearing the field restores all three rows.
- Keyboard Shift+Tab from the search input reaches New session, Collapse
  sidebar, then Settings. Settings has a visible focus ring; Enter opens the
  real Appearance page. **Exit Settings** returns to Home.
- Collapse and Expand sidebar still work and restore both new header controls.
- On mobile, the existing topbar Search control opens the navigation drawer
  and focuses the relocated input. `gateway` filters to **Gateway reconnect**.
  Search, Settings and New session have **44×44 px** touch targets; desktop-only
  Collapse remains hidden. The main area is inert only while the drawer is open.
- Mobile Settings closes the app drawer and opens Appearance without stale
  inert state. Opening Settings navigation and using Exit Settings returns to
  Home with its drawer closed. Escape from session search also closes the app
  drawer and restores interactivity.
- In short landscape, scrolling the final session row into view moves the
  sidebar body by **114 px** while the header remains at **16 px** and search
  at **72 px** from the viewport top. Both utilities remain reachable.
- Document and sidebar have **0 px horizontal overflow** in the checked sizes.
  Browser runtime errors and console error messages are empty.

## Checks and evidence

- `npm test -- src/views/shell.test.ts src/lib/session/sidebar-sessions.test.ts`:
  **37 passed**.
- `npm test`: **383 passed**.
- `npm run typecheck`, `npm run build`, `git diff --check`: passed.

This is an owner-requested layout adaptation, not an upstream pixel-parity
claim. It changes no API, dependencies or persisted formats. Close only the
dedicated browser tab and stop only the disposable HUI gateway; retain the
temporary fixture root for inspection.
