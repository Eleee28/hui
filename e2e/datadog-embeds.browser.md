# Datadog embeds browser verification

Verified on 2026-10-16 with HUI's Browser tool against the real HUI gateway from
`node e2e/visual-verification.mjs launch` (isolated HUI and PI state, fixture model).
Two runs: one through the operator's real `pup` 1.6.4 and the public Datadog share
page, one through the fake pup (`--datadog-fixture`, `e2e/fixtures/pup-cli-fixture.mjs`). The
real run was repeated on commit `9aabf54` with a clean tree (doctor passed before
cleanup). No operator HUI state was read or changed; the real run read Datadog only.

## Reproduce

1. Real graphs: `node e2e/visual-verification.mjs launch --branch <branch>` with a
   `pup` signed in to an org that has a dashboard (here `dani-org`). In Settings →
   Integrations → Datadog press **Add org** and add that org (the dialog preselects
   `app.datadoghq.com`), then start a
   session in the receipt's workspace whose message has a share link, a link to one
   of the org's widgets (`…/dashboard/<id>/<slug>?from_ts=…&to_ts=…&tile_focus=<widget>`)
   and the same dashboard without `tile_focus`. A second message links a
   `dd.datad0g.com` dashboard, an unknown dashboard and an unknown share
   (`…/s/<org>/zzz-zzz-zzz`).
2. Sign-in flows: `node e2e/visual-verification.mjs launch --branch <branch> --datadog-fixture`.
   Through **Add org**, add `e2e-prod` (signed in), then `e2e-staging` (no session: sign-in starts) and
   approve with `touch <run>/pup/approve`; add `e2e-stale` and **Cancel** its sign-in.
   Start a session whose message links `…/dashboard/stl-123-xyz/legacy?tile_focus=7`
   and `…/dashboard/abc-123-xyz/checkout?tile_focus=42&tpl_var_env[0]=staging`,
   press the card's **Sign in to e2e-stale** and approve again.
3. Check 1440×900, then 390×844. Then turn off Settings → Appearance → Chat →
   *Datadog link previews* and reopen the session.

## Observed

- Settings → Integrations → Datadog: *No orgs yet* and **Add org**, whose dialog
  preselects *app.datadoghq.com (default)* (the other public sites listed; *Other
  host…* adds a required *Host* field) and focuses *Org name*, which suggests pup's
  logins for that site. Adding `dani-org` closed the dialog, answered *Added
  dani-org.* and showed *app.datadoghq.com · Connected*; it survived a reload.
  Adding it again kept the dialog open with *That org is already in the list.* in
  red; Escape closed it, left Settings open and put focus back on **Add org**. At
  390×844 the dialog fit with full-width buttons.
- The real share link (`app.datadoghq.com/s/yB5yjZ/dgj-s33-htg`) showed
  *[streaming-topicstats] Lag (time) for a detailed topic* with the same graph
  Slack unfurls. The widget link showed *CPU usage (%)*, *dani-org · Home Server ·
  Oct 16, 07:20 PM – 08:20 PM* and the stacked area graph with its 60% marker
  (about 4 s, the snapshot's rendering). The plain dashboard link showed *Home
  Server*, *dani-org* and the description. Clicking a graph opened the media
  viewer with zoom, copy and save; Escape returned focus to the graph button.
- Errors: *Add a Datadog org for dd.datad0g.com in Settings → Integrations to
  preview it.*, *Not found in your Datadog orgs for app.datadoghq.com.*, *This
  share link is not available.*
- Fixture sign-in: adding `e2e-staging` showed *Signing in to e2e-staging* with
  **Open sign-in page** (the URL the fake printed) and **Cancel**, the status
  *Waiting for sign-in…*, and disabled *Add org* and *Sign in*. Approving turned it
  into *Signed in to e2e-staging.* and *Connected*. **Cancel** on `e2e-stale`
  returned the row to *Sign in needed*. The fake recorded
  `auth login --org=e2e-staging --site=datadoghq.com --no-agent`.
- Fixture cards: `stl-123-xyz` said *Sign in to e2e-stale to preview it.* with
  **Sign in to e2e-stale** / *Opens a browser on the computer running HUI.*; after
  the press, *Waiting for sign-in…* / *Approve the sign-in in your browser…*; after
  approval the card reloaded by itself as *Legacy error rate · e2e-stale · Legacy
  checkout · Past 1 hour*. The other card read *p99 latency in env:staging* (the
  link's template variable) with *Datadog could not draw this widget.* (the fake's
  snapshot answers 403).
- The fake's call log: lookups ran `dashboards get <id> -o json --no-agent
  --read-only --org=<name>` with `DD_SITE=datadoghq.com` and without the
  `DD_API_KEY` the gateway had, trying `e2e-prod`, `e2e-staging`, then `e2e-stale`.
- At 390×844 the cards and graphs fit the user bubble with no horizontal scroll.
- Turning *Datadog link previews* off saved `chat.datadogEmbeds: false`; reopening
  the session showed both messages with no Datadog cards.
- Console: no errors from these views (Lit dev-mode warnings only).

## Proof gap

The real `pup auth login` was not run: it opens the operator's browser and changes
their pup sessions. Its output (`If the browser doesn't open, visit: …`, the 300 s
callback wait) was read from pup's source, `src/commands/auth.rs`, and the fake
prints the same lines. Fixture snapshots are refused, so images in the fixture run
come only from the real share page.
