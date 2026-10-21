# Namespaced model launch and error feedback

Verified on 2026-09-24 with the OpenClaw Browser tool against the running HUI app.

## Scope

- A model ID may contain slashes after the provider separator. HUI preserves
  the complete reference through registry persistence and runtime startup.
- A failed launch keeps the draft and displays a theme-aware callout immediately
  below the composer, with matching edges, an icon, a heading, `role="alert"`,
  and a form `aria-describedby` association.
- This verifies real PI against the deterministic local Anthropic-compatible
  provider, **not** a live AI Gateway account or its credentials.

## Environment and reproduction

Use a fresh disposable directory as `$HUI_LAUNCH_RUN`, with `workspace`,
`xdg/hui`, `pi-agent`, `pi-sessions`, and `browser` subdirectories.

Seed `xdg/hui/settings.json` with Catppuccin, dark mode, and text scale 100.
Seed `pi-agent/settings.json` with `defaultProvider: "hui-e2e"`,
`defaultModel: "anthropic/claude-opus-fixture"`,
`defaultThinkingLevel: "low"`, and empty packages/extensions/skills arrays.
Seed `pi-agent/models.json` with:

```json
{
  "providers": {
    "hui-e2e": {
      "baseUrl": "http://127.0.0.1:43127",
      "api": "anthropic-messages",
      "apiKey": "e2e-not-a-secret",
      "models": [{
        "id": "anthropic/claude-opus-fixture",
        "name": "Claude Opus · namespaced fixture",
        "reasoning": true,
        "input": ["text", "image"],
        "contextWindow": 32000,
        "maxTokens": 4096,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
      }]
    }
  }
}
```

Run these foreground processes in separate terminals, from the repository:

```sh
HUI_E2E_WORKSPACE="$HUI_LAUNCH_RUN/workspace" \
HUI_E2E_PROVIDER_LOG="$HUI_LAUNCH_RUN/provider.jsonl" \
node e2e/fixtures/pi-provider-fixture.mjs

XDG_CONFIG_HOME="$HUI_LAUNCH_RUN/xdg" \
PI_AGENT_DIR="$HUI_LAUNCH_RUN/pi-agent" \
PI_CODING_AGENT_DIR="$HUI_LAUNCH_RUN/pi-agent" \
PI_CODING_AGENT_SESSION_DIR="$HUI_LAUNCH_RUN/pi-sessions" \
PI_OFFLINE=1 NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1 \
node --input-type=module -e 'import {createServer} from "vite"; const server=await createServer({server:{hmr:false,port:5173,strictPort:true}}); await server.listen(); server.printUrls();'
```

The Browser tool attached to an owned headless Brave profile, CDP port 18800,
with `--user-data-dir="$HUI_LAUNCH_RUN/browser"` and no proxy. The app URL was
`http://localhost:5173/`; desktop was 1440×900, mobile 390×844.
Stop only the owned fixture server, Vite, PI subprocess, and browser after the
check. Retain the disposable artifacts for inspection; do not touch user data.

## Browser journey and observations

1. Open Home. Enter a nonexistent directory beneath the disposable workspace
   and the prompt `Ping`, then click **Start session**.
2. Observe the expected HTTP 400 and **Could not start session** alert with the
   missing-directory detail. `Ping` remains editable; no session is registered.
3. Inspect and capture desktop, then resize to mobile. Both alert edges match
   the composer exactly; the long path wraps without horizontal overflow.
4. Open the model picker and select **Claude Opus · namespaced fixture**.
   Correct the directory to the existing disposable workspace. Escape the
   directory suggestions, Tab through the controls to **Start session**, and
   press Enter. The unchanged draft is submitted.
5. Observe successful session creation/open/events/prompt requests (HTTP 200),
   navigation to the new session, `Ping`, **Fixture response.**, and Idle state.
   The registry contains `hui-e2e/anthropic/claude-opus-fixture`; the real PI
   provider request contains `anthropic/claude-opus-fixture` and user text `Ping`.
   Exactly one session and one provider request were created.
6. Through Settings, switch to Claw and Light, exit Settings, open New Session,
   and repeat the invalid-directory submission. Inspect and capture the alert.

### Geometry and contrast

Contrast uses the browser's computed colors converted to sRGB and WCAG relative
luminance. Ranges cover both opaque gradient stops.

| Theme / viewport | Composer and alert left / width | Gap | Heading contrast | Detail contrast |
| --- | --- | --- | --- | --- |
| Catppuccin dark, 1440×900 | 465 / 768 px | 10 px | 6.01–6.64:1 | 8.94–9.88:1 |
| Catppuccin dark, 390×844 | 28 / 334 px | 10 px | 6.01–6.64:1 | 8.94–9.88:1 |
| Claw light, 1440×900 | 465 / 768 px | 10 px | 6.16–6.91:1 | 8.45–9.49:1 |

No page runtime errors. Error-level console output contained only the two
expected HTTP 400 resource errors from deliberate invalid-directory submissions.
Vite/Lit also emitted development-mode, update-cycle, and public-font-path
warnings. No unrelated console errors were suppressed. No fixed sleeps were
used for synchronization.

## Automated checks

- Before the fix, the new isolated namespaced-model regression failed with
  `Session model must use provider/id format.`
- `npm test -- server/hui-sse.test.ts`: 17 passed.
- `npm test`: 353 passed, none skipped.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
