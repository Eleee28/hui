# Configured PI model selection

Verified on 2026-09-24 with the OpenClaw Browser tool against HUI and real PI
0.73.1. Generation used the deterministic local provider, not a paid account.

## Scope and results

- PI's raw `get_available_models` returned **67** models: 25 Anthropic and 42
  OpenAI. HUI's New Session picker, live session picker and Models settings all
  displayed **2**, exactly the IDs selected in `models.json`.
- Other models from a configured provider were excluded, as was the authenticated
  provider absent from `models.json`.
- An initially excluded `openai/gpt-4o` default was replaced in the launch UI by
  the first configured choice; it was not silently submitted as the default.
- `SONNET anthropic` and `anthropic/anthropic/sonnet-fixture` each matched only
  Sonnet. Tab then Enter selected that result through the keyboard.
- Creating a session with Sonnet produced **Fixture response.** through real PI.
  Switching to Opus succeeded, and a second prompt produced another response.
  The provider log contained the exact IDs `anthropic/sonnet-fixture` and
  `anthropic/opus-fixture`, without losing either namespace.
- Create, open, events, models, model switch and both prompt requests returned
  HTTP 200. No page runtime errors or error-level console messages were recorded.
- Catppuccin desktop light/dark and mobile dark were visually inspected. Desktop
  was 1440×900. The Browser tool's iPhone 13 emulation reported a 390×664 CSS
  viewport at DPR 3. The mobile picker spanned x=12…378 and y=452…593 with both
  choices visible and no horizontal document overflow.

Missing/malformed/unreadable files, provider-only/empty lists, invalid entries,
an intentionally empty providers object, unavailable configured IDs, re-reading
selection changes and non-mutation of active models are covered by focused unit
tests. They are not claimed as separate Browser journeys.

## Reproduction

Create an isolated temporary root with `workspace`, `pi-agent`, `pi-sessions`,
`xdg/hui` and `browser` directories. Do not copy operator configuration.
Use that path as `HUI_MODELS_RUN` in the following commands.

Seed `pi-agent/models.json` with:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "http://127.0.0.1:43147",
      "api": "anthropic-messages",
      "apiKey": "fixture-not-a-secret",
      "models": [
        {
          "id": "anthropic/opus-fixture",
          "name": "Claude Opus · configured",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 32000,
          "maxTokens": 4096,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "anthropic/sonnet-fixture",
          "name": "Claude Sonnet · configured",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 32000,
          "maxTokens": 4096,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

Seed `pi-agent/auth.json` with `anthropic` and `openai` entries, each containing
`{ "type": "api_key", "key": "fixture-not-a-secret" }`. Seed
`pi-agent/settings.json` with `defaultProvider: "openai"`,
`defaultModel: "gpt-4o"`, `defaultThinkingLevel: "low"` and empty
packages/extensions/skills arrays. Seed HUI settings with `theme: "catppuccin"`;
use Browser color-scheme emulation for light and dark mode.

Start these in separate terminals from the checkout, with an environment stripped
of provider credentials and retaining only normal PATH/HOME/USER/LANG/TMPDIR:

```sh
HUI_E2E_PROVIDER_PORT=43147 \
HUI_E2E_WORKSPACE="$HUI_MODELS_RUN/workspace" \
HUI_E2E_PROVIDER_LOG="$HUI_MODELS_RUN/provider.jsonl" \
node e2e/fixtures/pi-provider-fixture.mjs

XDG_CONFIG_HOME="$HUI_MODELS_RUN/xdg" \
PI_CODING_AGENT_DIR="$HUI_MODELS_RUN/pi-agent" \
PI_CODING_AGENT_SESSION_DIR="$HUI_MODELS_RUN/pi-sessions" \
PI_OFFLINE=1 NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1 \
node --input-type=module -e 'import {createServer} from "vite"; const server=await createServer({server:{hmr:false,host:"127.0.0.1",port:5187,strictPort:true}}); await server.listen(); server.printUrls();'
```

Use an owned headless browser with its user-data directory under the fixture
root and CDP on port 18800. Navigate with the Browser tool to
`http://localhost:5187/` (the configured allowed hostname), open the model picker,
exercise both searches, select via keyboard, enter the disposable workspace and
submit a prompt. Wait for the visible response, switch models, submit again,
then open Settings → Models through the UI. Repeat picker inspection in mobile
emulation. No fixed sleeps are used for synchronization.

Stop only the owned provider, gateway, browser and their fixture PI processes.
Retain disposable data for inspection; no operator sessions, auth or model files
are involved. The actual provider's credentials/access were not tested.

## Checks

- `npm test -- server/runtimes/pi-models.test.ts server/runtimes/pi.test.ts server/pi/config.test.ts src/lib/model-selection.test.ts`: 34 passed.
- `npm test`: 360 passed, no skips.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
