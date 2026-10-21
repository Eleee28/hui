# Explicit bot knowledge

Follow `.agents/skills/hui-visual-verification/SKILL.md` from this checkout.
Use the default isolated launcher (real Durable gateway and deterministic PI
provider), at the clean committed branch HEAD, never the operator's state.

1. Run launch and doctor, retain its receipt and browser URL.
2. Create one disposable bot (a fixture soul may be seeded through the bot API).
   Open it from the Bots roster. In its overview choose Setup → Memory.
3. Observe the empty state. Choose Preference, enter a concrete preference and
   a source label such as “Our planning conversation”, then Save memory.
   Observe the entry and its manual provenance in the list.
4. Edit memory, correct its text and Save changes. Verify the original source
   stays and the updated time/revision appears. Pin memory; observe Pinned and
   the pressed state. Add a second Fact or Decision and verify pinned ordering.
5. Reload the owned tab and open Memory again. Verify both entries persist.
   A separate guarded API inspection/provider log can prove next-request
   prompt contents; it is not a substitute for the visible editing journey.
6. Delete memory opens a confirmation identifying the entry and warning that
   earlier conversation messages/summaries are not erased. Cancel first and
   verify it remains. Confirm Delete saved memory and verify it leaves the
   list. Save a final useful fixture preference for screenshots.
7. At 1440×900, 390×844 and 844×390, inspect the editor, entry actions,
   confirmation and panel scrolling. Repeat a relevant add/edit or pin action
   on mobile. Check keyboard labels/focus, document width and browser errors.
8. Run doctor, capture and inspect fresh desktop/mobile images outside Git,
   attach in the PR body and conversation, then cleanup the owned instance.

Saving explicit knowledge never runs a model. Existing OptChat conversation
memory is retained separately; manual corrections affect future knowledge,
not historical transcript contents. The server's gateway/worker tests cover
revision conflicts, persistence and prompt refresh on both execution hosts.
