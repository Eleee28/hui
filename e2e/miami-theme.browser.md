# Miami theme

Verified on 2026-09-24 with the OpenClaw Browser tool against the running HUI
application. This is a theme/Settings check, not a new PI generation or whole-app
pixel-parity claim.

## Fixture and reproduction

Create a temporary root (`HUI_MIAMI_RUN`) with `xdg/hui`, `pi-agent`,
`pi-sessions` and `browser` directories. Seed HUI settings with
`{"theme":"claw","themeMode":"dark","accent":""}` and PI settings with
empty `packages`, `extensions` and `skills` arrays. Start from the checkout:

```sh
env -i PATH="$PATH" HOME="$HOME" USER="$USER" LANG=C.UTF-8 \
  XDG_CONFIG_HOME="$HUI_MIAMI_RUN/xdg" \
  PI_CODING_AGENT_DIR="$HUI_MIAMI_RUN/pi-agent" \
  PI_CODING_AGENT_SESSION_DIR="$HUI_MIAMI_RUN/pi-sessions" \
  PI_OFFLINE=1 NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1 \
  node --input-type=module -e 'import {createServer} from "vite"; const server=await createServer({server:{hmr:false,host:"127.0.0.1",port:5188,strictPort:true}}); await server.listen(); server.printUrls();'
```

Use an isolated headless Chromium profile in the fixture, with CDP on 18800.
Navigate via Browser to `http://localhost:5188/` and click **Settings**. No
operator registry, settings, credentials or PI transcripts are changed. No model
request is needed. Stop only the owned gateway/browser processes after capture.

## Browser journeys and observed results

1. In Appearance, **Miami** appears as a built-in theme. Click it: its button
   becomes pressed, `data-theme` becomes `miami`, and HUI confirms the save.
2. Dark mode resolves the original violet-black background `#140f1e`, pink
   accent `#f472b6`, cyan secondary accent `#5fd7e8` and popover `#221a3a`.
   Focus and shadow roles come from the native stylesheet, not JSON mapping.
3. Reload: Miami and Dark remain selected. The preview swatches resolve to
   `#f472b6`, `#cfc7e8` and `#1c1530`.
4. Click **Light**: the selector becomes `miami-light`, background `#f7f3f6`,
   accent `#b0246f` and cyan secondary accent `#0f6f7d`.
5. Choose **Blue**, then **HUI**, press Tab to focus **Miami**, and Enter to
   select it. The focus outline is visible; Miami is selected and the saved
   `#5b9cf6` accent remains in effect. **Theme default** restores Miami's accent.
6. Choose **System** and emulate light then dark OS appearance: the same theme
   switches between `miami-light` and `miami` while the preference stays system.
7. Capture desktop at 1440×1000 in Dark. Emulate a mobile device, switch to
   Light, resize to 390×844 and reload: Miami and Light persist. The theme card
   remains reachable, the responsive Settings navigation is present, and both
   main-container and document horizontal-overflow checks are false.
8. Browser console errors and runtime errors: none.

## Source and checks

- `public/themes/miami.css` is byte-identical to OpenClaw 2026.9.5's standalone
  theme, SHA-256 `46c7e1855d75867affcc1dd45ed427952f6d469302815d7cdb247f47378df4be`.
- The existing native-palette guard includes this hash; selector tests cover
  both variants and a user theme with the same id keeps its custom mapping.
- `npm test -- src/lib/theme/theme.test.ts src/lib/theme/theme-store.test.ts src/lib/upstream-palette.test.ts src/lib/theme/shadcn-theme.test.ts`: 29 passed.
- `npm test`: 369 passed.
- `npm run typecheck`, `npm run build`, `git diff --check`: passed.
