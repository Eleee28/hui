# HUI-managed providers

## Scope and fixture

Use the repository visual-verification launcher with isolated HUI/PI state,
real PI SDK and the deterministic `hui-e2e` custom provider. Do not enter an
operator credential or make a model call to an external provider. Built-in
connection setup uses the synthetic key `hui-fixture-not-a-real-key`.

This journey complements `server/pi/providers.test.ts` (API-key and synthetic OAuth
interactions, cancellation, storage permissions, concurrent saves, redaction and
PI/HUI endpoint/auth precedence), `server/pi/provider-quota.test.ts` (quota windows,
fixed endpoints, response bounds and failure redaction), and
`server/pi/config.test.ts` (catalog invalidation during an in-flight probe).

## Browser journey

1. Open the launch receipt URL. Navigate Settings → Models.
2. Verify the empty state has **Add provider**, no provider model lists and no
   quota section. Add provider opens a modal with exactly OpenCode Go, OpenAI and
   Claude. OpenAI groups ChatGPT account and API key; Claude groups Pro/Max
   and API key. Escape closes the modal and restores focus.
3. Choose OpenCode Go → API key. Submit the synthetic key in the password input.
   The modal closes and an added card appears; quota loads independently and
   truthfully reports unsupported. Models remain collapsed until opened.
   Open Models, select two entries, inspect context/output limits and save.
4. Reload and reopen Models. Both selections persist. Search, change a selection
   and cancel: reopening must retain the saved selection. Add Claude → API key,
   cancel the pending sign-in and close the modal: no Claude card is added.
5. At 390×844, repeat add-dialog, model filtering and saving with the keyboard.
   Check no page-wide horizontal overflow, focus visibility or clipped controls.
   Check the modal at 844×390; its contents scroll within the viewport.
6. Remove the HUI connection using its confirmation. The PI fixture model remains
   available. Re-add a synthetic connection for final evidence. The available
   catalog is collapsed, and no custom-provider setup UI is offered. For a
   disconnected card, isolate fixture credential deletion/relaunch as setup:
   verify only Sign in appears, with no quota/model controls.
7. Exit Settings, start a PI session in the receipt workspace with `E2E_RICH`
   using the fixture model, and observe its real read-tool result and response.
   This proves the custom provider still works alongside HUI's built-in selections.
8. Inspect Browser page/console errors. Run doctor before capture. Capture the
   affected provider view at 1440×900 and 390×844, outside Git, from the committed
   PR HEAD; deliver through GitHub attachments and chat.

## Boundaries of this proof

The synthetic key proves UI/auth persistence, not external account validity.
Real external OAuth approval, token refresh against provider servers, paid model
inference and live subscription quotas require suitable accounts and are not
claimed by this fixture. OAuth interaction and numeric quota parsing have isolated
server tests. Browser resize proves
responsive layout, not native mobile touch behavior.

## Multiple accounts and priority (2026-09-27)

Use synthetic credentials only. Settings → Models → Add provider → OpenCode Go:
name the first account Personal and submit a synthetic API key. Add account on
its provider card, name it Backup and submit a different synthetic key. Verify
both named accounts are retained, Personal is Next to use and Backup is Standby.
Drag Backup by its grip above Personal, drop, reload and verify the order persists. Expand the shared model
dropdown, select two models and save. At 390×844, drag Personal above Backup and remove
Backup using the confirmation: Personal and both selected models must remain.
Re-add Backup for evidence. Exercise Add account → API key → Cancel sign-in and
Escape, ensuring Settings remains open and no cancelled account appears.
Inspect Current limits (unsupported is explicit for OpenCode Go), keyboard
operation and the modal at 844×390, and capture the final committed HEAD at
1440×900 and 390×844. No horizontal overflow or new Browser errors are expected.

The server tests additionally exercise a real PI OpenAI Responses adapter over
local HTTP: first synthetic key returns 429, second streams a successful reply.
They prove bounded exhaustion, persistent cooldown, reset recovery, no replay
of partial output, no failover on abort/non-quota errors, and concurrent OAuth
refresh pinned to the correct credential file. These tests do not claim live
subscription access or real external OAuth approvals.

### Drag-and-drop priority

There are no up/down priority buttons. Each account has a 44px grip. Dragging
shows the picked account and an insertion line; only dropping commits the order.
Test mouse dragging and touch-emulated dragging separately, including a list
long enough to scroll. Dropping outside the account section or pointer cancellation
must leave the saved order unchanged. Reconnect/remove/limits controls must still
work without starting a drag. Tab to a grip, Space to pick up, arrows or Home/End
to choose a position, Space/Enter to save; Escape/Tab cancels without saving.
After saving, focus stays with the moved account. Reload to prove persistence.
Failed saves must display the error and retain the last confirmed order.


## Subscription and all usage periods (2026-09-27)

Launch `node e2e/visual-verification.mjs launch --branch <branch> --quota-fixture`.
This seeds disposable accounts and intercepts only their quota transport in the
test-only Vite entrypoint; the production parser and UI handle synthetic upstream
payloads. Other provider routes stay real, including unsupported API-key usage.
No external credentials, OAuth, billing verification or provider requests occur.

1. Navigate Settings → Models. Limits are visible immediately, not behind a
   disclosure. Claude shows 5 hours, weekly, Sonnet weekly and monthly extra usage;
   absent plan/billing/reset data is explicitly not reported.
2. OpenAI ChatGPT Personal shows plan plus, usage Available and five meters:
   5 hours, weekly, code review weekly, Spark 5 hours and monthly credits. Backup
   shows plan pro and Limit reached. Refresh each account independently and
   retain its own values. The API-key card reports unsupported, never zero usage.
3. Repeat Refresh limits at 390×844. All meters and reset labels wrap without
   document or inner-card horizontal overflow. Verify keyboard focus on Refresh.
4. Reorder the two accounts with the grip (Space, End, Space), reload, and verify
   limits remain attached to the same named account. Restore Personal first.
5. Check 1440×900, 390×844 and 844×390. Inspect browser errors. Capture desktop
   and mobile from the clean committed HEAD, after a passing doctor check.

Server tests additionally cover partial/malformed responses, zero and over-limit
usage, missing/expired reset times, new scoped windows, monthly budgets and
cooldowns: only exhausted account-wide windows may block an account. Credentials
never imply active billing; the supported usage APIs do not report billing status
or renewal dates. Screenshots are synthetic presentation proof, not live account
subscription verification.


### Account heading spacing

At 390×844 and 1440×900, check that the description below Account priority
starts 12px below the full Add account button row (the generic description has
a negative margin and must not pull into this row). Click Add account, then
Escape; the dialog must close without leaving Models. Check the same layout at
320px width and ensure no horizontal overflow. Capture desktop/mobile evidence
from the committed HEAD.

### Reported identity and Go limits

The quota fixture now includes OAuth-shaped synthetic Codex credentials and a
synthetic Claude profile response. Account headings, grip/removal accessible
names and reorder announcements must show the reported email, not Personal or
Backup. A long email wraps at 390×844; keyboard reorder retains focus and the
opaque account ID. Reload preserves the order. Other API keys keep a fallback
label, with no inferred email. OpenCode Go is now supported: refresh exposes
5 hours (0.5%), Weekly (32%) and Monthly (68%), with individual reset times.
The isolated transport exercises the real quota fetch/parser; service tests prove
per-account key selection/cache/cooldown and separate same-email OAuth accounts.
This is not a live external subscription test.

### OpenCode account-name help

Open Add provider → OpenCode Go (or Add account on its card). The Account name
input is required and a muted small note immediately below explains that OpenCode
does not report the account name or email. Empty/whitespace input must stay in
the dialog without starting login; entering a name enables the API-key prompt.
Reconnect prefills the stored label. OpenAI/Claude retain optional labels and do
not show this note. Check desktop, mobile and landscape dialog scrolling.
