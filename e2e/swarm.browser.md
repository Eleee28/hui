# Browser journey: Swarm (collected subagents and the Parallel tasks card)

Default launcher (`node e2e/visual-verification.mjs launch`): Durable sessions,
real codemode and the deterministic provider. No fixture code is specific to
this journey; the parent's script is sent with the provider's generic
`E2E_CALL:<base64url JSON>` tool call, and the children use existing replies:
`E2E_REPLAY` streams a prefix and holds until `POST <providerUrl>/control/release-replay`,
`E2E_ABORT` streams until its request closes, and `E2E_SUBAGENT_CHILD` answers at once.

## Prompts

Build each prompt with Node and paste it into the composer:

```js
const call = (marker, code) => `${marker} E2E_CALL:${Buffer.from(JSON.stringify({ name: "codemode", input: { code } })).toString("base64url")}`;
// 1. Queue: 1 child that times out, 33 held children (32 run, 1 queued).
call("E2E_SWARM", `const spawn = async (task, extra = {}) => JSON.parse(await tools.sessions_spawn({ task, collect: true, ...extra }));
const runs = [await spawn("E2E_ABORT", { label: "Flaky check", runTimeoutSeconds: 1 })];
for (let i = 1; i <= 33; i += 1) runs.push(await spawn("E2E_REPLAY", { label: "Check " + i }));
const waited = JSON.parse(await tools.agents_wait({ ids: runs.map((run) => run.taskId) }));
const by = {};
for (const item of waited.completed) by[item.status] = (by[item.status] ?? 0) + 1;
return "Collected " + waited.completed.length + " results: " + JSON.stringify(by);`);
// 2. Stop: three held children; 3. success: three that answer at once.
const three = (task) => `const runs = [];
for (let i = 1; i <= 3; i += 1) runs.push(JSON.parse(await tools.sessions_spawn({ task: "${task}", label: "Reviewer " + i, collect: true })));
const waited = JSON.parse(await tools.agents_wait({ ids: runs.map((run) => run.taskId) }));
return waited.completed.map((item) => item.label + ": " + item.status).join("; ");`;
call("E2E_SWARM_STOP", three("E2E_ABORT"));
call("E2E_SWARM_OK", three("E2E_SUBAGENT_CHILD"));
```

## Journey and expected results

1. Send prompt 1. The card above the composer reads **Parallel tasks · 1 of 34**,
   32 blue dots, one hollow and one red, and "32 running · 1 queued · 1 failed or
   stopped". **Child details** lists **Flaky check** ("The subagent exceeded 1
   seconds."), the running checks and the queued one ("Waiting for a free slot…").
   The sidebar shows the parent alone, with no row for any helper.
2. Release the replay once: 32 checks complete and the queued **Check 33** starts.
   Release again: the parent's reply is `Collected 34 results: {"timed_out":1,"completed":33}`
   and the card reads "33 completed · 1 failed or stopped" with "Child runs
   finished. Check the conversation for the final response." No "subagents
   finished" event appears in the transcript.
3. Activate a child row: its transcript opens; **Open parent** returns.
4. Send prompt 2 and press **Stop** while the three run: "0 completed · 3 failed
   or stopped", each "Stopped with its parent."; no completion event follows.
5. Send prompt 3: the card folds into **✓ Parallel tasks · 3 completed**.
6. Repeat 1 and 5 at 390×844: the card and composer fit without overflow.
