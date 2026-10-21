# Pinned OpenClaw presentation

Reference: OpenClaw **2026.9.5**, source commit
[`ec9c1a13db8938e5a3eaa51fca2e981cde2395a9`](https://github.com/openclaw/openclaw/tree/ec9c1a13db8938e5a3eaa51fca2e981cde2395a9).
License: MIT; see [third-party notices](../../../THIRD_PARTY_NOTICES.md).

`manifest.json` records the source path and SHA-256 of every sheet. **32 sheets
are verbatim** after removing the provenance comment and outer whitespace.
Five contain selected rules: Appearance from `config.css`, implemented plugin
inventory rules from `plugins.css`, and Settings sidebar/page chrome from
`layout.css`, plus the session title/indicator rules from that same sheet.
The source hash is retained separately for these excerpts.

The browser entry imports styles in a fixed order. Do not fix a mismatch by
adding another competing color/radius/padding rule. Inspect the source selector,
DOM ancestry, inherited variables, state and cascade first. `reference.test.ts`
detects unreviewed changes to this versioned snapshot.

## Explicit transport and product adaptations

- HUI keeps Lit and PI RPC; it does not ship OpenClaw's Gateway. The approved
  Web Awesome 3.12.0 dependency now owns Settings selectors/switches, hub tabs
  and sidebar/task menus, using the original shadow-part rules directly.
  Composer popovers and dialogs still have explicit native adapters in
  `../openclaw-{chat,shell,workspaces}.css`. Modal, keyboard, focus, dismissal
  and viewport behavior require separate E2E checks.
- App and Settings use the upstream browser drawer query (900 px, plus short
  landscape through 932 px) and `shell--mobile-nav`. Compact content retains the
  separate upstream 768 px/landscape rule.
- PI branding, real runtime/session data and HUI-owned settings replace
  OpenClaw data. No fake avatar, Fast mode, dictation or approval controls.
- At the project owner's explicit request, session search and Settings occupy the left side
  of the sidebar header; collapse and new session remain on the right. The
  separate Settings footer is removed.
- PI inventory/install and scheduler forms retain their existing contracts,
  using the original Settings rows, controls and action classes.
- The attachment-only menu uses the upstream attachment surface (176 px), not
  the 208 px combined capability menu whose extra features HUI does not expose.
- `.chat-thread` is not a size container (`openclaw-chat.css`): in Chrome it made
  every keystroke and streamed token lay out the whole conversation again. The
  position rail's controller measures the thread's content box for the rail's
  height and its 960 × 360 px hide rule instead of `chat-transcript` queries.

## Verification

`e2e/fixtures/reference-style-server.mjs` serves the pinned source CSS read-only. The
Browser probe resolves the same DOM under both cascades and copies native
focus/hover/popover state. This detects divergent declarations; it is **not**
independent proof of original DOM equivalence or a screenshot pixel diff.
Pair it with source anatomy review, real PI journeys and inspected screenshots;
see [the visual goal](../../../docs/visual-parity-goal.md) and the E2E report.

`e2e/probes/original-component-probe.js` additionally renders the actual pinned composer,
Effort and textarea controller with the original Lit/WA runtime in a disposable
frame. `e2e/probes/native-switch-probe.js` is retained as a historical pre-migration
diagnostic; `e2e/probes/webawesome-controls-probe.js` now measures the actual migrated
picker, switch, select, tab and dropdown shadow parts against the shipped
original runtime. These are
independent component proofs, not a claim about every original application page.
The native popover color and attachment-host typography adapters were corrected
from those original renders, which a same-DOM cascade probe cannot replace.

The original theme/accent evaluators now derive reference colors independently.
`original-settings-probe.js`, `original-sidebar-probe.js` and
`original-transcript-probe.js` exercise actual original renderers too, with
matched visible data. Unmeasured control states, native composer transports, missing PI
timestamp metadata and unsupported Fast mode remain explicitly bounded.
Rosé's authoritative native CSS lives in `public/themes/`, separately hash-guarded.
OpenClaw's nine self-hosted webfont families and their OFL texts live in
`public/fonts/`; HUI adds System as the tenth picker option and applies the
selected interface/chat stacks through the original `--font-body` and
`--font-chat` variables.

Regenerate hashes only after reviewing a deliberate reference change. Never
update the manifest merely to make a failing regression pass.
