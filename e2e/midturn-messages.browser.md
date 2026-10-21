# Messages written mid-turn stay in sight

Journey for SPEC.md "Every assistant message stays in sight": a message the
agent writes in the middle of its turn, before more tool calls, keeps its own
row once the turn ends. Only the thinking and tool calls between messages fold.

HUI, Pi Durable and the read tool are real; only the model provider is
deterministic. `E2E_MIDTURN_MESSAGE` makes it write a *What to check* message
with two links, call `read`, then answer *Started two helpers in the
background…* after the tool result.

## Reproduce

1. Launch and run doctor. Create a session in the receipt's workspace through
   the visible **New session** flow.
2. 1440×900: send `E2E_MIDTURN_MESSAGE` from the composer and wait until the
   turn ends (the composer is ready again and the session is idle).
3. Check the transcript: your message, the *What to check* message with both
   links clickable, one folded **Ran 1 command** row (the `read` call), and the
   final *Started two helpers…* message. Expand the folded row: it holds only the
   tool call. Reload the page: the same rows come back.
4. 390×844: the same rows, nothing clipped.

## Before this change

On `origin/main` (with only this fixture added), the finished turn shows a
single folded **Ran 1 command** row that hides the *What to check* message, and
only the final message stays visible.
