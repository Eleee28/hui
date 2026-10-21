# Agent-presented media browser check

Verified 2026-09-24 against the real HUI gateway, PI SDK worker and deterministic
Anthropic-compatible fixture provider. All HUI/PI state lived under a fresh
`/tmp/hui-presented-media-e2e-*` root; no operator transcript or credential was
read or changed.

## Journey

1. Start the fixture provider with `HUI_E2E_WORKSPACE` pointing at a disposable
   workspace containing a generated PNG, MP4/H.264, MP3 and generic PDF file.
2. Start HUI with isolated `XDG_CONFIG_HOME`, `PI_CODING_AGENT_DIR` and
   `PI_CODING_AGENT_SESSION_DIR`, using the SDK backend and local fixture model.
3. Open the registered **Media capabilities** session through its visible
   navigation link, type `E2E_PRESENT_MEDIA` in the real composer and activate
   **Send message**.
4. The provider requests the real `present_media` tool. Wait for the four media
   presentations and the final assistant response; no transcript or DOM state
   is injected.
5. Reload, wait for PI history to repaint the same four presentations, switch
   to 390×844 and re-check the responsive layout.

The managed OpenClaw Browser wrapper timed out in both `status` and its single
documented `start` retry after the gateway restart. Per the browser-automation
fallback, the rendered journey was driven in `/run/current-system/sw/bin/brave`
through a private CDP port by `e2e/probes/presented-media-probe.mjs`. This is real browser
interaction and rendering, but it is not a successful managed-Browser-tool run.

## Observed

- The PNG loaded inline (`complete=true`, non-zero natural width).
- MP4 and MP3 reached `HTMLMediaElement.HAVE_ENOUGH_DATA` (`readyState=4`) and
  exposed native controls.
- A byte-range request against the video returned `206` and
  `Content-Range: bytes 0-31/180968`, proving the seek transport.
- The PDF remained a named download card rather than an unsafe inline embed.
- Reload reconstructed all four items from PI's durable tool-result details.
- Desktop and mobile had zero document overflow. The 390 px viewport rendered
  the video at 372 px wide.
- CDP captured zero page exceptions, console errors and network failures.

## Automated coverage

- Media staging/classification, opaque URLs, wrong-name rejection and HTTP byte
  ranges: `server/agent-tools/presented-media.test.ts`.
- Safe client projection and size labels: `src/lib/presented-media.test.ts`.
- Streaming and durable PI tool-result details: `server/runtimes/pi.test.ts` and
  `src/lib/transcript-state.test.ts`.
- Agent-visible prompt guidance and tool registration:
  `server/runtimes/pi-sdk.test.ts`.
- Visible transcript ordering: `src/views/chat/projection.test.ts`.
