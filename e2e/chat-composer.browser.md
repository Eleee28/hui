# Browser journey: HUI-04 chat and composer

This journey uses the real installed PI RPC process with a deterministic local
Anthropic-compatible provider. It requires no external credential or network
access and never reads the operator's PI/HUI directories.

## Isolated setup

Create a disposable root and the PI configuration below (replace `<ROOT>` and
`<PORT>` literally with the chosen values):

```bash
HUI_E2E_ROOT="$(mktemp -d /tmp/hui-e2e-hui04.XXXXXX)"
mkdir -p "$HUI_E2E_ROOT/home" "$HUI_E2E_ROOT/xdg" \
  "$HUI_E2E_ROOT/pi-agent/extensions" "$HUI_E2E_ROOT/pi-sessions" \
  "$HUI_E2E_ROOT/workspace"
printf 'fixture contents\n' > "$HUI_E2E_ROOT/workspace/fixture.txt"
cp e2e/fixtures/question-extension.ts "$HUI_E2E_ROOT/pi-agent/extensions/question-extension.ts"
```

Create `$HUI_E2E_ROOT/pi-agent/models.json`:

```json
{"providers":{"hui-e2e":{"baseUrl":"http://127.0.0.1:43127","api":"anthropic-messages","apiKey":"e2e-not-a-secret","models":[{"id":"fixture","name":"HUI E2E Fixture","reasoning":true,"input":["text","image"],"contextWindow":32000,"maxTokens":4096,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}]}}}
```

Create `$HUI_E2E_ROOT/pi-agent/settings.json`:

```json
{"defaultProvider":"hui-e2e","defaultModel":"fixture","defaultThinkingLevel":"high"}
```

Start the provider, then the gateway in separate terminals:

```bash
HUI_E2E_WORKSPACE="$HUI_E2E_ROOT/workspace" \
HUI_E2E_PROVIDER_LOG="$HUI_E2E_ROOT/provider.jsonl" \
HUI_E2E_PROVIDER_PORT=43127 \
node e2e/fixtures/pi-provider-fixture.mjs
```

```bash
HOME="$HUI_E2E_ROOT/home" \
XDG_CONFIG_HOME="$HUI_E2E_ROOT/xdg" \
PI_AGENT_DIR="$HUI_E2E_ROOT/pi-agent" \
PI_CODING_AGENT_DIR="$HUI_E2E_ROOT/pi-agent" \
PI_CODING_AGENT_SESSION_DIR="$HUI_E2E_ROOT/pi-sessions" \
PI_OFFLINE=1 \
node bin/hui.mjs gateway
```

Open the printed URL in a new managed Browser tab. Clear requests, console and
page errors before starting. Use fresh snapshots after every rerender.

## Visible-control journey

1. Create `HUI-04 Browser E2E` with **Project directory** set to the isolated
   workspace. Wait for `Idle` and model `HUI E2E Fixture`.
2. Send `E2E_RICH`. Assert **Running**, visible thinking, a running then
   completed `read` tool card with `fixture contents`, the final `Tool complete`
   Markdown heading/list/code, then **Idle**. Activate **Copy response** and
   assert its visible copied status.
3. Upload a tiny PNG and `notes.txt` through **Attach images or files**. Assert
   thumbnail/names/removal controls; send `E2E_ATTACHMENTS`. Assert names on the
   user turn and `Attachment received by PI.`. The provider log must contain an
   image block; the stored file must be below the isolated
   `xdg/hui/attachments` tree. Reload after settlement and assert the original
   image/file names remain while neither the immutable path nor the HUI manifest
   appears in the visible message. Unicode and spaces in a display name are
   valid; path separators and controls are rejected. Uploading more than eight,
   a file larger than 12 MB, or more than 16 MB total must show an error and
   create no prompt request.
4. Send `E2E_ABORT`. Wait for `Abort prefix` and **Stop**, activate Stop, then
   assert **Idle**, no Stop, and an enabled composer. Send one normal message to
   prove the session remains usable.
5. Send `E2E_REPLAY`. Wait for `Replay prefix`, reload the same direct session
   URL while the gateway remains running, and assert `Running` plus the prefix.
   Release the provider barrier with:

   ```bash
   curl -fsS -X POST http://127.0.0.1:43127/control/release-replay
   ```

   Assert exactly `Replay prefix — replay suffix`, with neither loss nor
   duplication, then `Idle`.
6. Hold a second `E2E_REPLAY` at its barrier. Submit `STEER_QUEUED` as **Steer**
   and `FOLLOWUP_QUEUED` as **Follow up**. Assert both queue rows in the UI,
   release the provider barrier, and verify the provider receives them in that
   order. As each row leaves the queue, assert it appears as a user turn before
   the next blocked response finishes. The queue must empty and the session
   return to `Idle`.
7. Send `/hui-e2e-question`. Assert the modal named **HUI E2E question**, answer
   through its labelled input, and verify it closes, clears the command, returns
   focus to **Message**, and settles to `Idle`. Repeat and cancel with Escape,
   checking the same focus/cleanup behavior.
8. Send `E2E_TOOL_FAILURE`; assert the `read` card is visibly failed and keeps
   its error output. Send `E2E_ERROR`; assert an alert containing `fixture
   provider error`, return to Idle, reload, and verify PI's durable error row.
9. Change **Thinking level**, reload the direct session URL, and assert the
   choice persisted. Resize to 390×844 and 844×390; assert document, main,
   header and composer have no horizontal overflow and every composer control
   remains inside the viewport.
10. For the prompt endpoint only, wrap `window.fetch` in a manually controlled
    promise without forwarding the request. Prepare one exact payload (text and
    an attachment), submit it, and wait for **Sending…**. Assert the textarea,
    attachment picker, removal controls and submit action remain disabled for
    the whole acknowledgement window: the user cannot start or alter another
    draft while ownership of the submitted payload is unresolved. Reject the
    controlled promise, then assert the composer restores exactly the submitted
    text and attachment once, with the failed pending turn and visible error.
    Restore the original fetch by reloading.

## Stable selectors

- labels: `Project directory`, `Message`, `Attach images or files`, `Model`
- buttons: `Start session`, `Send`, `Stop`, `Copy response`, `Steer`, `Follow up`
- attachment removal: `Remove <filename>`
- tool cards: accessible name `Tool <name>: running|succeeded|failed`
- thinking: accessible name `Thinking`
- question: dialog name `HUI E2E question`
- failures: `role=alert`; copy/connection/queue feedback: `role=status`

## Diagnostics and cleanup

Assert no page errors or JavaScript console errors in a stable final pass. SSE
disconnect errors are expected only while deliberately restarting/HMR-reloading
the gateway. The provider returns the deliberate `E2E_ERROR` 500 to PI; HUI
surfaces it over SSE while its own prompt/control endpoints remain 2xx, with no
model-409 loop.
Stop gateway/provider, close only the disposable tab, and move the recorded root
to trash. Never remove paths that were not printed as `$HUI_E2E_ROOT`.

## Verified evidence — 2026-09-22

The Browser-tool run used PI 0.73.1, the fixture above and one stable direct
session tab. It proved:

- streamed thinking, Markdown and correlated `read` progress/output/failure;
- copy feedback, image + file transport, immutable stored paths and 12 MB guard;
- abort followed by a usable normal prompt;
- reload during `E2E_REPLAY` with one prefix and one suffix;
- Unicode attachment names surviving settle and reload with transport metadata
  hidden from the visible transcript;
- a delayed prompt acknowledgement locking the composer, followed by exact
  text/attachment recovery when that acknowledgement is rejected;
- visible Steer/Follow up queue rows, promotion into the live transcript, and
  provider delivery in that order;
- a Follow up with a Unicode-named attachment showing only its user text while
  queued, then surviving settlement and reload with the original display name
  and no absolute path or HUI manifest exposed;
- Question answer and Escape cancellation with draft cleanup, focus restoration
  and `Idle` settlement;
- a durable provider error after reload and persisted thinking level;
- zero page errors and zero horizontal overflow at 390×844 and 844×390.

The only console/network failures during the long development trace were the
expected SSE disconnects from deliberate gateway restarts. A fresh final tab
then loaded the direct session in `Idle` with persisted `low` thinking, zero
page/console errors, zero overflow, and ten HUI bootstrap requests all returning
200.
