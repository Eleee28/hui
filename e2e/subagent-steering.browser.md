# Browser journey: child completion steers its active parent

Verified on 2026-09-25 using the real PI SDK worker runtime and the deterministic local
provider in disposable HUI/PI directories. No operator sessions were modified.

## Reproduction

Use the isolated setup in [chat-composer.browser.md](chat-composer.browser.md).
Start `e2e/fixtures/pi-provider-fixture.mjs` and HUI, then use the Browser tool:

1. Create a session through the visible project/prompt controls, using the
   disposable workspace and `E2E_SUBAGENTS_STEERING`.
2. The fixture asks PI to spawn `E2E_STEERING_CHILD`. The parent then executes
   a real bash/curl tool held at `/control/wait-subagent-parent`. The child only
   completes once that barrier is reached, so completion cannot race an idle
   parent.
3. Observe the completed background child while the parent remains Running.
   The rendered queue panel contains exactly
   one `[HUI subagent completion event]` labeled **Steer**, with no Follow up row.
4. Release the provider barrier (not a HUI endpoint):
   `curl -fsS -X POST http://127.0.0.1:<PROVIDER_PORT>/control/release-replay`.
5. Observe the parent reply: `Parent incorporated the child result through
   steering.` The parent becomes Idle, the queue disappears, and the completion
   appears once in the transcript. No Stop or additional user prompt is needed.

The final journey used a fresh session after integration onto current main.
The event renders as a non-user system card. Browser page errors: zero.
Keep fresh screenshots outside Git and include them in the PR description.

## Automated coverage and limits

`server/agent-tools/subagents.test.ts` covers idle delivery, active/waiting steering,
preservation of a pending question, refused/unsupported steering, settlement
during rejection, and avoiding duplicate follow-ups or parent aborts. Fallback
routing is verified at the session-service boundary, not Browser-driven fault
injection. The browser uses a deterministic local model provider, not a remote
model's discretionary tool selection.

Validation on integrated main: focused subagent tests (12 passed), full
`npm test` (581 passed), `npm run typecheck`, `npm run build`, and
`git diff --check`. The build retains its existing large-chunk warning.
The initial RPC checkout was also Browser-verified before integration; its
full suite (440 tests), typecheck and production build passed.
