# HUI working mark — browser verification

2026-09-24. A CSS-built H replaces the OpenClaw claw and trailing dots in the
primary chat indicator. Its uprights breathe in alternation and its bridge
pulses; reduced-motion renders a static H. Context labels remain unchanged.

## Reproduce

- `npm ci`; `HUI_E2E_PORT=43139 npm run e2e:sdk`.
- Open localhost:43139 with the Browser tool. Select the disposable workspace
  printed by the fixture and submit `E2E_REPLAY` through Start session.
- While the provider barrier holds, inspect the live indicator at 1440×900
  and 390×844. Capture the observed page with `e2e/probes/capture-rendered.mjs`.
- Release the fixture provider's `/control/release-replay` barrier and inspect
  the settled response.

## Observed

- Real SDK turn, submitted through visible browser controls; Writing response
  label and three running CSS animations (`huiWorkingUpright`,
  `huiWorkingBridge`, `huiWorkingUpright`). No OpenClaw icon in the indicator.
- Desktop and mobile screenshots inspected; no document horizontal overflow.
- On settlement the indicator and Stop button disappeared, and the full replay
  response remained visible. No browser runtime or error-console entries.
- `npm test`: 428 passed; `npm run typecheck` and `npm run build` passed.
- Reduced-motion fallback is defined in CSS; OS preference emulation was not
  exercised in this pass.
