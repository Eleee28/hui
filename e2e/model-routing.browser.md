# HUI model routing and `/btw`

Verified on 2026-09-24 with the OpenClaw Browser tool against HUI and real PI
0.73.1. Generation used the deterministic local Anthropic-protocol fixture;
no paid account or operator configuration was used.

## Scope and results

- Settings persisted separate primary, fallback and utility routes. Their copy
  explains when each route runs and includes OpenAI/Anthropic examples.
- Creating a session sent the first prompt to the utility route for naming. Its
  `Fixture response.` became the normalized short title `Fixture response`.
- The normal session turn stayed on `anthropic/primary-fixture`.
- `/btw which model named this session?` opened the side rail, answered through
  `anthropic/utility-fixture`, and did not add either side-chat message to the
  main transcript.
- The side rail was inspected at 1440x900 and 390x844. The mobile layout had
  zero horizontal document/body overflow. No browser runtime errors were found.

Primary failure before useful output, a single cross-provider retry from OpenAI
to Anthropic, and refusal to retry that turn twice are covered by the focused
`LiveSessions` unit test.

## Reproduction

Create an isolated root containing `workspace`, `pi-agent`, `pi-sessions`,
`xdg/hui`, and `browser`. Configure three models in `pi-agent/models.json` under
a local Anthropic-protocol provider: `primary-fixture`, `fallback-fixture`, and
`utility-fixture`. Point them at `e2e/fixtures/pi-provider-fixture.mjs`, and seed HUI's
settings with those three canonical model IDs.

Start the fixture provider and Vite with `XDG_CONFIG_HOME`,
`PI_CODING_AGENT_DIR`, and `PI_CODING_AGENT_SESSION_DIR` pointing exclusively
inside that root. Start an owned headless browser with its profile under the
same root. In HUI:

1. Open Settings -> Models and verify all three selections and descriptions.
2. Start a session from the disposable workspace with
   `Implement model routing E2E`.
3. Wait for `Fixture response.` and verify the title is `Fixture response`.
4. Send `/btw which model named this session?` and verify the ephemeral side
   rail names `anthropic/utility-fixture` while the main transcript is unchanged.
5. Inspect at desktop and mobile widths and query browser errors/overflow.

## Checks

- `npm test`: 464 passed, no skips.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- Browser errors: 0.
- Mobile document/body horizontal overflow: 0 px.
