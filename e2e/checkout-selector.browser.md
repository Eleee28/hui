# Checkout and worktree selector

Verified on 2026-09-24 with the OpenClaw Browser tool against the running HUI
app.

## Environment

- Disposable Git repository with `main` and `topic` branches under `/tmp`.
- Isolated `XDG_CONFIG_HOME`; no operator HUI registry or PI transcript was read
  or changed.
- Vite gateway at `http://localhost:5173/`.
- Desktop viewport: 1440 x 900. Mobile viewport: 390 x 844.

## Journey

1. Open New Session and enter the disposable repository as the project
   directory.
2. Observe the checkout trigger resolve to the repository's current `main`
   branch.
3. Open the Checkout popover and select **New worktree**.
4. Observe the trigger change to **New worktree from main**, the `From` field
   offer discovered refs with HUI-owned menu rows instead of the browser's
   native datalist dropdown, keep the repository default branch first, and the
   optional `Name` field explain that the session title supplies its default.
   Selecting a branch writes it into `From` and closes the branch suggestion
   list while keeping the checkout popover open.
5. Return to **Current checkout**, choose `topic` from the same `From`
   suggestions, and verify the selector stays in Current checkout mode, the
   worktree `Name` field remains hidden, and the branch suggestion list closes.
6. Use **Configure default prefix** to open `/settings/worktrees` scrolled to
   its Git worktrees section, where the `branchPrefix` input lives.
7. Inspect the rendered popover at desktop and mobile widths. The mobile popup
   repositions above its trigger, remains fully visible and introduces no
   horizontal document overflow.

The server-side integration test separately creates a real worktree from an
explicit non-current base ref and verifies the selected commit is checked out.
The Browser journey intentionally stops before submission so it does not start
PI or create a transcript.

No page runtime errors were observed. The prefix Settings follow-up used a
temporary Brave/CDP profile after the shared browser profile reported
attach-only and unavailable. The first shared browser process was
closed by a concurrent HUI run between viewports; the mobile pass was repeated
from a fresh disposable Brave profile attached to the configured CDP port.
