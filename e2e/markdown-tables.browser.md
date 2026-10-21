# Markdown tables browser check

Verified 2026-09-24 using the real HUI gateway and PI 0.73.1.

## Reproduce

1. Create a fresh `/tmp/hui-markdown-tables-*` root. Configure the isolated
   `hui-e2e/fixture` model using `chat-composer.browser.md` before launching PI.
2. Run `node e2e/fixtures/markdown-tables-fixture.mjs <ROOT> <PI_PACKAGE>/dist/core/session-manager.js`.
   It seeds one disposable PI conversation and an exclusive HUI registry.
3. Start `npm run dev` with `XDG_CONFIG_HOME=<ROOT>/xdg`,
   `PI_AGENT_DIR=<ROOT>/pi-agent`, `PI_CODING_AGENT_DIR=<ROOT>/pi-agent`,
   `PI_CODING_AGENT_SESSION_DIR=<ROOT>/pi-sessions`, and `PI_OFFLINE=1`.
   This run used `http://localhost:5174`. No provider requests are needed to
   resume the seeded history; no operator transcripts or registry are touched.
4. Open Home with the Browser tool and click **Open Readable tables**. Wait
   for the resumed history and Idle. This exercises the real session renderer,
   not injected HTML or app state.

## Observed

- At 1440×1000, both tables render semantic headers/cells, inline code and bold.
  The six-row usage table retains all numbers; its numeric column aligns right.
  The wide table demonstrates left, center and right alignment.
- At 390×844, the usage table fits the 374px content area. The wide table has
  a 374px viewport and 640px scrollable content. Document overflow is 0px.
- Clicking the wide table focuses its viewport. ArrowRight scrolls it to 40px;
  the document remains within the viewport. Native scrolling is asynchronous.
- Browser page errors and console error entries are empty.

## Automated checks and scope

`npm test -- src/lib/markdown/markdown.test.ts`: 11 passed. Full `npm test`: 415 passed.
`npm run typecheck`, `npm run build`, and `git diff --check`: passed.

Unit coverage includes escaped pipes, optional outer pipes, missing/extra cells,
malformed and streamed headers, fenced code, blockquotes, inline formatting and
HTML/link safety. Streaming prefixes are unit-tested, not exercised with a live
provider in this browser journey. This is the supported pipe-table subset, not
full GFM conformance. Existing reference table CSS is reused without dependencies
or API/persisted-format changes.

## Remote integration recheck

The remote advanced during this task. The table commit was cherry-picked onto
`b05af38` in an isolated worktree, preserving the shared checkout's in-progress
changes. After `npm ci`, all **433 tests**, typecheck and build passed there.
The Home → Readable tables browser journey was repeated on localhost:5173 with
that integrated version. Two tables, zero mobile document overflow and no
browser/console errors were confirmed. No force push or shared-checkout reset
was used.
