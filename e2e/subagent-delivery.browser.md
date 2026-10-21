# Durable subagent completion delivery

Verified 2026-09-25 with the real PI SDK worker and the deterministic local
provider, using disposable state under `/tmp/hui-durable-browser`. Gateway:
`http://localhost:5198`; provider: `http://127.0.0.1:43219`.

## Reproduction and observations

1. Use the isolated PI configuration from `chat-composer.browser.md` and launch
   `e2e/fixtures/pi-provider-fixture.mjs`. Start Vite with the disposable XDG config,
   PI agent directory and PI session directory (not the operator's state).
2. In the Browser tool, fill Project directory with the disposable workspace
   and start `E2E_SUBAGENTS_STEERING` through the visible form.
3. The real child completes while the parent is held at the fixture's bash
   barrier. Observe one Steer entry in Queued messages. The child registry
   record remains `completionDelivery: pending` across retry ticks; no duplicate
   queue entries appear.
4. Release `/control/release-replay` on the fixture provider. Observe Idle,
   one system completion card and `Parent incorporated the child result through
   steering.` The retry loop confirms the child as `delivered` after the event
   appears in the parent transcript.
5. Stop the disposable gateway. In its fixture registry only, change that
   child's delivery marker back to `pending` to simulate loss of the HUI ack
   after PI persisted the event. Restart the same gateway and navigate back to
   the parent with the Browser tool.
6. Observe one completion card and the original response, still Idle. The
   marker returns to `delivered`. The provider request count remains **4 before
   and 4 after restart**: recovery did not launch a duplicate model turn.
7. Inspect the rendered desktop (1440x1000) and mobile (390x844) views. Fresh
   screenshots belong in the PR description, never in repository history.

Browser page errors: zero. Development console warnings include Lit dev mode,
Lit/Web Awesome update scheduling and the existing public-font URL warning.
The deliberate gateway restart produces expected connection interruptions.

## Boundary coverage and scope

Focused tests cover refusal/retry, timer-driven recovery, lost volatile steering,
transcript deduplication after acknowledgement loss, single-flight concurrent
attempts, failed registry acknowledgement, completed/interrupted sibling batches,
legacy non-replay, and delivery-state registry round trips. Transport and disk
faults, and loss of a queued event, are injected in these tests rather than
claimed as Browser-driven failures. The browser uses deterministic model output,
not discretionary delegation from a remote model.

Checks: `npm test` (604 tests after integration onto current main), `npm run typecheck`, `npm run build`, and
`git diff --check`. Build retains its large-chunk advisory. Stop only the
fixture provider and gateway processes started for this journey after handoff.
