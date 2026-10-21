# Remote access over a slow link

Date: 2026-10-07. Linux, Node 24, headless Brave (Chrome 153), HUI 0.1.3 at the
branch's HEAD, production build served by the built gateway (not Vite).

Proves what a phone on mobile data through Tailscale sees: how soon something
paints, how soon the app and a long conversation are usable, and that a
conversation that fails to load says so and offers a retry.

## Reproduce

1. `npm ci && npm run build`.
2. Seed one long Durable session (160 turns, a 1.96 MB transcript) into fresh
   state, then start the built gateway on that state:

   ```sh
   D=$(mktemp -d); export XDG_CONFIG_HOME=$D/config XDG_DATA_HOME=$D/data XDG_CACHE_HOME=$D/cache \
     PI_CODING_AGENT_DIR=$D/agent PI_OFFLINE=1 HUI_PI_BACKEND=sdk HUI_E2E_WORKSPACE=$D/workspace
   mkdir -p $D/agent && node e2e/fixtures/long-session-fixture.ts
   node bin/hui.mjs gateway run --host 127.0.0.1 --port 43331
   ```
3. In another shell, put a slow link in front of it (300 ms round trip,
   1.6 Mbit/s down, 800 kbit/s up; `--rtt-ms 600 --down-kbps 300` for a bad one):

   ```sh
   node e2e/fixtures/slow-link-proxy.mjs --target 127.0.0.1:43331 --port 43432
   ```
4. With the Browser tool, open `http://localhost:43432/sessions/e2e-long-session`
   in a new labeled tab (a port not visited before, so nothing is cached). Read
   `performance` paint and resource entries and wait for *Step 160* in the
   transcript. Capture the boot screen early, the conversation loading state and
   the loaded conversation, at 1440×900 and 390×844.
5. Boot screen colours: on a fresh origin it paints HUI's light (`#faf9f7`)
   or dark (`#0e1015`) background for the system preference, never bare white.
   Switch the theme (for example Catppuccin with a custom accent), load the app
   once, then reload over a slow link: the boot screen paints in that theme's
   background, text and accent (remembered per device in `localStorage`).
6. Failure path: with the app loaded on Home, stop the gateway, select *Long
   remote session*: the transcript area shows *Could not load this
   conversation* with the reason and *Try again*, never an empty chat. Start the
   gateway again on the same state and press *Try again*: the conversation loads.

## Observed

| 300 ms / 1.6 Mbit/s | main | this branch |
| --- | --- | --- |
| First paint | 6.7 s, blank page | 1.8 s, boot screen |
| App painted, sessions requested | 23.0 s | 5.8 s |
| Long conversation | open aborted after 5 s: *The user aborted a request.* toast over an empty *Start a conversation* | painted at 7.0 s |
| Bytes for the open answer | 1,957,957 | 39,343 |

At 600 ms / 300 kbit/s the branch shows the boot screen, then *Still loading —
the connection is slow* after 6 s, and the conversation arrives intact.

## Limits

The proxy models latency and one shared bandwidth budget over HTTP/1.1 to
loopback; Tailscale serve speaks HTTP/2 to the phone and adds its own TLS
handshakes and DERP relays. A real phone on mobile data was not part of this run.
