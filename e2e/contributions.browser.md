# Contributions page

Verified on 2026-09-30 with the HUI Browser tool (headless) against
`node e2e/visual-verification.mjs launch --branch <branch> --github-fixture`.
The fake `gh` (`e2e/fixtures/github-cli-fixture.mjs`) is signed in to `hui-e2e` (active,
created 2022) and `hui-e2e-personal` (created 2019), each with deterministic
synthetic commits and pull requests since creation in `<run>/gh/contributions.json`.
No operator GitHub account was read.

## Journeys and observed results

1. Sidebar **Contributions** (first destination) opens `/contributions`: heading
   "1,015 commits in the last year", a 53-week calendar with month and
   Mon/Wed/Fri labels and a Less→More legend, then "Commits per week" with 53
   bars.
2. The year list shows *Last 12 months* (pressed), 2026 … 2019. **2025** shows
   "1,035 commits in 2025" (fixture: 807 + 228 in local 2025) with the calendar
   starting on Wednesday Jan 1; `<run>/gh/search-log` searched
   `2024-12-31..2026-01-01`. **2026** leaves days after today blank and has no
   bars for future weeks.
3. The header **Pull requests** switch changes both charts ("166 pull requests
   in 2026", "Pull requests per week").
4. **Account** lists *All accounts*, `hui-e2e`, `hui-e2e-personal`; choosing
   `hui-e2e` narrows the charts and the year list to 2026 … 2022. The search log
   shows the personal account's searches with `token=fake-token-hui-e2e-personal`
   and the active account's with no token.
5. Add `hui-e2e-broken` to `<run>/gh/accounts` with a string error in
   `contributions.json`, then **Refresh**: a warning names the account and gh's
   message while the other accounts' charts still render.
6. Empty `<run>/gh/accounts` and remove `account`, then **Refresh**: "No GitHub
   account is signed in to gh on the HUI machine." with **Connect GitHub**, which
   opens Settings → Integrations (*Sign in with GitHub*).
7. 390×844: header controls wrap, the year list becomes a scrolling row above
   the charts, and both charts scroll horizontally, opening on the most recent
   weeks. Dark mode renders the GitHub-like green steps.

`?year=2007`, `?year=abc` and `?year=2031` return 400.

Hover (checked 2026-09-30 with a real mouse move over CDP, since Browser-tool
refs do not reach SVG squares): a day shows a tip such as "4 commits on Sun,
Sep 28, 2025" above an outlined square; a week shows "8 commits · week of Sep
27, 2026" above its bar. Tips past the middle grow leftwards and stay inside
the card at 1440×900 and 390×844. Choosing **Pull requests** and
`hui-e2e-personal`, then reloading, keeps both choices.
