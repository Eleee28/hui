# Routine recovery browser verification

This journey covers the bot Routines page, overview Activity and Automations'
shared retry/intervention presentation. Use the repository-owned visual
verification skill and its default isolated launcher: HUI, Pi Durable and
Automation are real, only the model provider is deterministic. Do not use an
operator's accounts, workers, transcripts or scheduler state.

## Setup and actions

1. Launch the exact committed checkout, retain its persistent process handle,
   and require the printed receipt's doctor checks before Browser work and
   final capture. Create a fixture bot
   (*Ada*, with a short soul) through the guarded API as setup.
2. Add a routine (*Morning digest*, hourly, prompt `E2E_RICH review the fixture`)
   through the bot's visible Routines page. Click **Run now**, observe its
   real tool activity and answer, then **Completed** in Latest runs. Send a
   second message to check the chat remains usable.
3. For failure presentation, seed only the launcher's disposable
   `config/hui/automation.json`, while no task is running. Keep its version,
   real tasks and runs. Add a historical failed run with a synthetic quota
   error and `failure: { kind: "rate-limit", needsAttention: true }`. This is
   **seeded presentation**, not proof of a live provider quota response.
   Reopen Routines, observe **Needs attention**, the quota/billing guidance
   and original error. Return to the overview to inspect Activity.
4. For a real pre-delivery connection failure, prepare a temporary local
   worker as in `e2e/bots-workers.browser.md`: install this checkout's worker
   release in an isolated home and connect it through Settings → Workers/API
   setup. Create its bot and an hourly routine, then disconnect the worker.
   Click the routine's **Run now** in the visible Routines page. Observe
   **Retry scheduled**, **Attempt 1/3**, its original connection error and the
   actual next retry. Open Automations and use **Cancel** before that time;
   verify **Cancelled** and no further retry promised. This uses a real worker
   host on loopback, not an external machine or billable provider.
5. Repeat the relevant Routines/Activity interaction at 1440×900, 390×844 and
   the height-sensitive sheet at 844×390. Capture fresh desktop/mobile views
   outside the repository. Check focus, overflow and Browser page/console
   errors; publish the observed results and any fixture limitations in the PR.

## Recovery boundary proof

- `server/automation.test.ts` uses an observable manual clock and disposable
  registry: retries keep one run/deadline/count, survive restart and stop on
  cancellation/exhaustion/end; classification never permits replay by itself.
- `server/bots/schedules.test.ts` starts a real routine whose isolated command
  is held by the provider, stops/restarts the backend and asserts one input,
  one run id, the recorded result and one temporary-run consumption.
- `server/runtimes/durable.test.ts` verifies request deduplication, exact-input
  cancellation and receipt recovery without replaying a side-effecting tool.
- Legacy runtimes cannot recover missing/ambiguous deliveries: the bot service
  tests require intervention, not another prompt.

These checks complement Browser interaction; neither a seeded status nor a
screenshot proves a real worker reconnect or external-provider failure. The PR
records the exact checks and Browser actions that actually ran.
