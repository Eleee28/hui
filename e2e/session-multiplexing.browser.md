# Browser journey: OpenClaw session multiplexer parity

Verified on 2026-09-25 against an isolated HUI gateway and real PI SDK workers,
using the OpenClaw Browser tool. Include fresh screenshots in the PR description,
never in Git history.

## Reference and adapter boundary

Reference: installed OpenClaw 2026.9.5, commit `ec9c1a13`.

- Layout mutations: `control-ui-boot-shared-Bt2ZINpX.js`.
- Drop hit testing/rendering: `control-ui-boot-chat-CLUFzlXZ.js`.
- Three-slot LRU retention with queue-edit pins:
  `control-ui-boot-shared-hN7_nGsj.js`.
- Divider: `control-ui-core-C5mtYcym.js`.
- Existing verbatim startup-layout/split-view styles supply geometry, focus
  desaturation, hidden inactive controls, minimum sizes and drop indicators.

The authenticated reference conversation was not available in the isolated
browser: it displayed its gateway-token gate. No credential was fetched or
injected. This is an installed-code/behavior port, not a claim of an authenticated
pixel-by-pixel screenshot comparison. HUI retains its PI transcript/composer,
session IDs, native sidebar drag payload and routes. Its compact header uses a
Pane actions dropdown for overflow split actions, and its merged mobile shell
keeps the active pane's navigation toggle visible.

Run the independent model comparison with the installed reference's assets:

```sh
node e2e/probes/session-multiplexer-oracle.mjs /path/to/openclaw/dist/control-ui/assets
```

It executes the shipped layout/drop functions, not HUI-derived expected values.
Result: 1,000 seeded layout transitions and 10,201 drop positions match.
Extracted-function SHA-256:
`aef09805a6650eb12c03dee0e222ed0c2e881e3649649fcf40ee5ee663c9cf9e`.

## Isolated environment

```sh
HUI_E2E_PORT=43264 npm run e2e:sdk
```

The fixture supplies its own temporary workspace, HUI registry, PI agent
directory and deterministic provider; it never uses the operator's sessions or
credentials. Browser URL: `http://localhost:43264/`. Desktop: 1440×1000;
mobile: 390×844. The provider holds prompts prefixed `E2E_REPLAY` after
`Replay prefix —`; its `/control/release-replay` endpoint releases only these
disposable runs.

## Visible-control coverage

| Interaction | Observed |
| --- | --- |
| Create/open | Three sessions created through New Session; each received a real Fixture response and reached Idle. |
| Up/down drops | Sidebar rows dropped on a header/composer inserted above/below the targeted pane in the same column. |
| Left/right drops | Rows dropped at the target pane's left/right controls added a column on that side, not always on the right. |
| Center replacement | Drop onto the transcript center changed only that pane; prior view stayed mounted and returned with the same instance. |
| Same-session split | Split right and keyboard Pane actions → Split down created distinct pane identities; no duplicate DOM IDs. |
| Focus and close | Clicking either side revealed its controls. Closing rightmost and leftmost panes retained all surviving DOM instances. |
| Resizing | Native pointer drag changed column weights. Arrows changed 2%, Shift+arrows 5%; Home/End reached 15%/85%. Horizontal keyboard resizing also passed. |
| Persistence | A full reload restored columns, stacked rows, active pane, IDs and resized weights from browser-local state. |
| Concurrent turns | Beta completed a normal turn while Alpha stayed Running. Then both showed held streams, composers and active Stop controls. |
| Mobile | Only the active pane was visible; navigation selected another pane with all instances, hidden running streams and Gamma's draft retained. No page or inner composer/header overflow. |
| Close running view | Closing Alpha on mobile removed its pane, left its registry status Running, and retained the other pane instances. |

Pure tests additionally cover every close fallback, immutable mutations,
malformed persisted state, three-slot eviction and pinned queue edits. Closing
a view is distinct from removing a session from the registry.

## Diagnostics and handoff

The final integrated-code pass reported zero page exceptions and no new console
errors. The console retained ten earlier `ERR_CONNECTION_REFUSED` resource
errors from Vite's restart during the rebase (2026-09-24 22:09:30 UTC); navigating
again after the fixture was ready recovered the app before the final pass.
Center and edge drop previews were checked at their actual full/half-pane
dimensions, including `DOMRect` prototype properties. The request guard returned
403 without `x-hui: 1` and 200 with it; real SDK responses proved runtime binding.

Validation: 554/554 tests, strict TypeScript, production build and the independent
reference oracle passed. Fresh desktop (three panes, two Running) and mobile
screenshots were captured after integration and visually inspected. For a new
change, regenerate PR evidence outside Git. Stop the disposable fixture and close
only the task-owned browser tabs after delivery.
