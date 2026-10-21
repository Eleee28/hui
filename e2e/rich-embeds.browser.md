# Rich Markdown embeds browser check

Verified 2026-09-24 against the real HUI gateway, PI SDK worker and deterministic
Anthropic-compatible fixture provider. HUI and PI state lived under a fresh
`/tmp/hui-rich-embeds-e2e-*` root; no operator transcript or credential was
read or changed.

## Journey

1. Start `e2e/fixtures/pi-provider-fixture.mjs` with the disposable workspace and the
   isolated `hui-e2e/fixture` model, then start HUI on `localhost:5199`.
2. Through New Session, choose the fixture workspace, enter
   `E2E_RICH_EMBEDS`, and activate **Start session**. The real PI turn returns
   one Mermaid fence, one Vega-Lite chart, inline/display math, one GitHub-style
   callout, one isolated bare X status URL and one labeled X link.
3. Before consent, inspect the rendered diagram and X facade. Confirm there is
   no X widget script or iframe, while the labeled URL remains one normal link.
4. Activate **Load post** and wait for X's official widget iframe. Reload the
   session to prove PI's original Markdown repaints the diagram and privacy
   facade without a HUI transcript format.
5. Check 1440×960 and 390×844, including the loaded post on mobile.

## Observed

- Mermaid painted a real SVG flowchart and Vega-Lite painted a second SVG chart
  from inline JSON. KaTeX produced accessible MathML/HTML for both formulae and
  the TIP marker became a semantic callout. Their JavaScript remained in dynamic
  chunks until the corresponding syntax appeared.
- Before consent: `twitterScript=false`, `iframe=false`, the privacy facade was
  visible and the labeled URL stayed an anchor.
- After consent: the official Jack status `20` iframe rendered successfully.
  The widget's fixed desktop width was constrained by HUI to 310 px inside the
  328 px mobile card.
- Desktop and mobile document/conversation overflow were both 0 px. On mobile
  the diagram was 328 px wide with a 306 px SVG viewport.
- The page reported zero runtime exceptions. X's optional settings/telemetry
  requests produced expected `ERR_CONNECTION_REFUSED` / `ERR_BLOCKED_BY_CLIENT`
  console resource errors in the managed privacy-filtered browser; the post
  itself still rendered. HUI emitted no application error.

Rendered desktop and mobile captures were inspected and delivered directly in
the conversation as transient handoff artifacts; they are intentionally not
stored in the repository.

## Automated coverage

- Markdown recognition, strict allowlist behavior and escaping:
  `src/lib/markdown/markdown.test.ts`.
- Agent-visible presentation guidance through the real PI SDK:
  `server/runtimes/pi-sdk.test.ts`.
- Production dependency audit: `npm audit --omit=dev` reported zero
  vulnerabilities with pinned `mermaid@11.17.2`.
