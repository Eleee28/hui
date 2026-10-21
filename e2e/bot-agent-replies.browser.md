# Bot replies to the originating agent

Journey for SPEC.md "Bots can notify the agent that handed them work": an
agent hands a bot a compact task brief, the bot receives a gateway-generated
return address, and a later decision request reaches that same agent. An
unrelated session remains unreachable through this reply-only path.

Verified on October 16, 2026 with `e2e/visual-verification.mjs launch --branch
<feature-branch>`. HUI, Pi Durable, OptChat, tool execution and message delivery
are real. Only the model provider is deterministic. API calls create isolated
fixture state; the handoff and replies are sent through visible chat controls.
No real PR, account, credential or installed gateway is used.

## Reproduce

1. Launch the feature checkout with the repository verifier and run its doctor.
   Use the receipt's workspace, browser URL and isolated API URL.
2. API setup: create Grace with a short soul (no kickoff),
   and create two Durable sessions in the fixture workspace: *Implement retry
   fix* and *Unrelated PR work*. Retain their returned IDs. Bots default to
   anyone being able to tag them in this disposable fixture.
3. At 1440×900, open *Implement retry fix*. In its Message composer, send
   `@grace` and an `E2E_CALL` that invokes `message_bot` to `@grace`. Its message
   is a compact brief: fixture PR URL/head, bounded-retry intent, decisions to
   keep three retries and add no dependency, CI/conflicts-only scope, explicit
   worktree ownership, and checks already run/gaps.
4. Open Bots → Grace through the sidebar. Check the received brief and the
   `[from agent: Implement retry fix · reply-to agent:<originating id>]`
   header. The return address must identify the actual calling session.
5. In Grace's composer send an `E2E_CALL` invoking `message_bot` with
   `to: "agent:<originating id>"` and a review decision request, such as
   "PR #7 review needs your decision: keep the agreed retry limit or change
   it? No code changed." This is a later turn, so the received-message
   history, not just the current run input, must authorize it.
6. Through the same composer, try a call to `agent:<unrelated id>`. Observe
   "A bot can only reply to agents that have messaged this bot." The unrelated
   session must receive nothing.
7. Open Agents → *Implement retry fix*. Observe the attributed `[from @grace]`
   request and a fresh response from that agent's runtime, not merely a tool
   receipt in Grace's chat.
8. At 390×844, use the navigation drawer to open Grace, submit a callback from
   the mobile composer, and return to the originating session. Inspect the
   callback after reloading; verify the chat controls and message wrap fit.
9. Run doctor again, inspect the console and rendered screens, save desktop
   and mobile screenshots outside Git, and clean up through the receipt.

The existing fixture accepts `E2E_CALL:<base64url JSON>` where JSON is
`{ "name": "message_bot", "input": { "to": "…", "message": "…" } }`.
For example, generate one with:

```sh
node --input-type=module -e 'console.log("E2E_CALL:" + Buffer.from(JSON.stringify({name:"message_bot",input:{to:"agent:CALLER_ID",message:"Review needs your decision."}})).toString("base64url"))'
```

Replace `CALLER_ID` with the isolated session ID from setup. Never use an
operator's real session or send fixture commands into the installed app.

## Observed and limits

- The compact brief arrived intact with the originating session's return
  address. The source agent saw its handoff accepted.
- A later bot turn sent the decision request to that exact agent. It appeared
  as `[from @grace]` and the real Durable session ran a new turn in response.
- The unrelated-session attempt was refused visibly. Service tests also cover
  embedded/assistant-quoted fake addresses, receipts belonging to another bot,
  busy-recipient queues, archived/deleted/completed recipients, budgets and
  preserving the three-hop limit through a round trip.
- The callback was submitted through desktop and mobile composers. On mobile,
  the request persisted across reload and wrapped within the 390-pixel view.
- No console errors were observed. Lit's development-mode and update-scheduling
  warnings were present; this journey changes no frontend rendering code.
- Automated worker coverage exercises both a local bot notifying its calling
  agent on a worker and a worker bot notifying its calling local agent.
- This proves HUI's control flow, not a model's judgment, real CI repairs,
  comment deduplication or a complete live PR watch. No real GitHub writes,
  merge, deployment or installed-app restart occurred.
