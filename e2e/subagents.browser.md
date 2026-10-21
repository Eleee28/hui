# Browser journey: session-tree subagents

Verified on 2026-09-24 with the installed PI 0.73.1 RPC process, HUI's real
gateway and the deterministic local provider. The run used a disposable HUI
root, PI agent directory, session directory and workspace. It did not read or
change operator sessions, credentials or PI configuration.

## Reproduction setup

Use the isolated provider/model setup from
[chat-composer.browser.md](chat-composer.browser.md), with a fresh temporary
root and `http://localhost:5173` for HUI. Set `XDG_CONFIG_HOME`,
`PI_AGENT_DIR`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, and
`PI_OFFLINE=1` to disposable fixture paths. Start the local fixture provider,
then start HUI with `npm run dev`.

The provider's `E2E_SUBAGENTS_START` path asks real PI to call
`sessions_spawn`. The child receives `E2E_SUBAGENT_CHILD` in a separate PI
session and returns a deterministic result. `E2E_SUBAGENTS_COORDINATE` makes
the parent call `sessions_list`, `sessions_history`, and `sessions_send` in
sequence; the child answers the inter-session message.

## Visible-control journey and observed results

1. Create a session through **New session** and submit
   `E2E_SUBAGENTS_START`. The parent visibly runs one command and returns to
   Idle while the child runs independently.
2. The sidebar adds **Fixture researcher** beneath its parent. The transcript
   shows a **Background agents** row with the child result, matching
   OpenClaw's active/recent-task presentation. (Since Swarm, this is the
   **Parallel tasks** card above the composer; see [swarm.browser.md](swarm.browser.md).)
3. Click the background row. HUI opens the child's persisted transcript in the
   same UI. Its header identifies it as a subagent and **Open parent** returns
   to the owning session.
4. In the parent, submit `E2E_SUBAGENTS_COORDINATE`. PI executes three real
   extension tools. The final visible reply is
   `Coordination complete: Cross-session reply from child.`, proving that the
   parent listed the tree, read the child's transcript, sent a message, and
   received the correlated reply.
5. At 1440×900 the nested session row, transcript and recent background task
   remain usable. At 390×844 the task row and composer fit without horizontal
   overflow (`scrollWidth === innerWidth === 390`).
6. The final Browser tab reports no page errors or console errors. No journey
   step invokes HUI's HTTP endpoints directly; all product behavior is driven
   through visible controls and the real PI RPC runtime.

The `subagents` tool's list, steer and kill actions, task timeout handling,
restart interruption, tree isolation, and bridge authentication are covered by
focused server tests. They are not presented as Browser-verified interactions
because HUI intentionally exposes those operations to the agent tool contract,
not as additional operator controls.

## Validation and evidence

- Focused runtime, bridge, registry, snapshot and presentation tests; full
  `npm test`: **494 passed**.
- `npm run typecheck`, `npm run build`, and `git diff --check`: passed.

The post-audit rerun also covered the UTF-8 byte bound on `sessions_history`.
OpenClaw's Browser control timed out on both its status check and one restart
attempt, so that rerun used the documented host-browser fallback: Brave driven
over CDP with Playwright against the same real Vite gateway and installed PI
runtime. The clean pass followed only visible controls, observed one nested
child and one background-task row, completed the list/history/send chain,
measured zero desktop/mobile document overflow, and reported zero console or
page errors. The earlier Browser-tool journey above remains the direct plugin
proof; the fallback rerun is not attributed to the managed Browser tool.

Stop only the disposable gateway, provider and browser processes and close the
fixture tabs. Retain the temporary root for inspection; do not delete operator
PI/HUI data during cleanup.
