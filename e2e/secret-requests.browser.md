# Secret requests browser verification

Date: 2026-10-06. Verified against commit `16c9e8f` of
`dani.fernandez/add-secret-prompt-agents`, and the PI worker flow again at
`50e62aa` after its bridge client changed, launched with the repository
visual-verification fixture (`e2e/visual-verification.mjs launch`, then again
with `--pi-sessions`) and driven with the Browser tool. Only the model provider
is mocked (`e2e/fixtures/pi-provider-fixture.mjs`, `E2E_SECRET_REQUEST`); HUI, the
gateway, Pi Durable, the PI SDK worker, the `secret_request` tool, the real
`bash` tool and the browser are real. The secrets typed were throwaway
strings; no operator credential was used.

## Reproduce

1. From a clean checkout: `node e2e/visual-verification.mjs launch --branch
   <branch>` (Durable) or with `--pi-sessions` (PI SDK worker), then `doctor`
   on the receipt.
2. In the Browser tool, open the receipt's `browserUrl`, choose the printed
   workspace as the project directory and send `E2E_SECRET_REQUEST`.
3. The fixture calls `secret_request { label: "Fixture API key", reason }`.
   Once the result names a file, it runs a real `bash` command that prints
   only the file's length and deletes it, then answers.
4. After each run, `grep -r -a` the fixture's temporary directory (HUI config
   and Durable store, PI's agent directory and transcripts, the provider
   request log in `artifacts/provider.jsonl`) for the typed value, and for
   `Fixture API key` as a positive control.

## Observed

- The request appears in the question dock above the composer: *Secret 1/1*,
  *Fixture API key*, the reason, *Kept out of the conversation: the agent gets
  a temporary file, never the value.*, a focused masked *Value* field, *Cancel*
  and *Submit*. The session header reads *Waiting for your answer* and the
  sidebar row shows the waiting hand; the gateway's session list reports
  `waiting`.
- Submitting closes the card. The `secret_request` row records only the label,
  the reason and *The operator provided "Fixture API key". It is in
  /tmp/hui-secret-<gateway pid>-XXXXXX/secret until <time>…*; the next `bash`
  row prints *Secret length: 33*, the typed value's length, and the agent
  answers. The directory is `drwx------` and empty after the agent's `rm`.
- The typed values were found nowhere under the fixture directory, on
  Durable (store and its WAL) and on the PI worker (its JSONL transcript),
  while `Fixture API key` was found in both stores and the provider log.
- *Cancel* ends the request; the agent reports that the operator cancelled
  it. *Stop* closes the card and leaves the session idle on both runtimes (the
  PI worker's row shows PI's usual *This operation was aborted*).
- Escape in the field leaves the card open and the run waiting.
- A reload while the request is pending shows the card again.
- At 390×844 the card fits the conversation width: the reason wraps, and
  *Value*, *Cancel* and *Submit* stay visible above the composer; submitting
  there completes the same way.
- Stopping the fixture gateway deleted the delivered directories, and a
  gateway start removed a planted `hui-secret-2147483646-*` directory (a PID
  no process has).
- Browser console: no page errors. The only entries were the known
  development warnings (Lit dev mode and `change-in-update` scheduling).

## Remote worker

Verified against commit `a82e157` of `dani.fernandez/secret-request-remote-workers`
with the default launcher and a worker on the same machine: a separate home
(`/tmp/hui-remote-e2e/home`) reached through `env` with the launcher's HUI and
PI directories unset, as `server/workers.test.ts` does. The checkout was
pre-installed there as the worker release (the same steps as that test), so
connecting needed no network. The worker was added through the gateway API
(`POST /__hui/workers` and `…/connect`; typing into Settings → Workers was
unreliable in HUI's managed browser at the time) and showed *connected*.

1. On the new-session page, **Run on** listed *local-remote* under *Remote
   workers*; with it chosen and `~/project` as the folder, `E2E_SECRET_REQUEST
   on the worker` started a session whose header read *durable on
   local-remote · Waiting for your answer*.
2. The same Secret card appeared on the gateway. After Submit, the
   `secret_request` row named `/tmp/hui-secret-<pid>-…/secret` with the
   worker host's PID (not the gateway's), and the `bash` row on the worker
   printed the typed value's length.
3. The typed value was found nowhere under the fixture directory or the worker
   home (its Durable store and WAL included); `Fixture API key` was in the
   worker's Durable WAL and the provider log.
4. Stop while the card was open closed it and left the session idle; Cancel
   ended the request with the agent reporting the cancel. At 390×844 the card
   fits as it does locally.
5. A local session in the same gateway still got its file in a directory named
   with the gateway's PID.
6. Stopping the gateway and then the worker host (SIGTERM) removed both
   delivered directories.

## Evidence

Screenshots captured from the running instances (desktop 1440×900 pending,
provided and PI worker; mobile 390×844 pending) are attached to the pull
request, not committed here.

## Limits and gaps

- HUI's managed browser carries a 1Password extension, which attaches its
  inline icon to the masked field. Whether a browser's own password manager
  offers to save the value cannot be observed in headless Chrome; the field
  uses `autocomplete="one-time-code"` so browsers treat it as a one-time code.
- The 15-minute expiry and the 10-minute file deletion are covered by
  `server/agent-tools/secret-requests.test.ts` with mocked timers, not by waiting in the
  browser. A PI worker call that waits more than five minutes was checked by
  hand against a loopback server that replied after 310 s: the bridge client
  succeeded where `fetch` failed with `UND_ERR_HEADERS_TIMEOUT` after 301 s.
- The worker ran on the same machine as the gateway, so this does not prove
  an SSH transport or a Linux worker; the protocol is the same stdio stream.
