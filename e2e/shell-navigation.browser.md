# Browser journey: shell navigation and responsive drawers

> Changed on 2026-10-06: the sidebar header no longer has New session or Search
> sessions (the owner's call). It holds only **Collapse sidebar**, first in the
> top row, where **Expand sidebar** appears while the sidebar is collapsed, so
> step 1's header assertion is now that single control. New sessions start from
> a group's **New session in …**, and Ctrl+K finds sessions.

This journey proves HUI-02 against the rendered application. It exercises only
navigation and read-only pages; it does not create, mutate, or delete PI data.

## Setup

Start HUI with `node bin/hui.mjs gateway`, open the printed localhost URL in an
OpenClaw-managed Browser tab, and reuse that tab throughout the journey. Clear
page-error logs before beginning.

## Desktop journey (1440x900)

1. Open `/` and assert **Primary navigation** lists exactly Contributions,
   Kanban, Sessions and Settings, in that order, with no Home entry.
   Assert the sidebar header holds only **Collapse sidebar**, with no Settings
   button.
2. Assert all 26 retained capability buttons are present. Assert Agents,
   Approval, Approvals, Apps, Channels, Cloud Workers, Custodian, Device,
   Devices, Lobsterdex, Meetings and Portals are absent.
3. Click **Activity**, then **Worktrees**. Assert the paths are respectively
   `/activity` and `/worktrees`, the matching page
   heading is visible, and the selected nav item has `aria-current="page"`.
4. Use browser back and forward. Assert both pathname and heading return to the
   corresponding capability.
5. Open **Settings**. Assert exactly 11 links are present: Appearance,
   Connection, Sessions, Models, Tools, Skills, Automation, Plugins, Memory,
   Security and Diagnostics. Channels and Nodes / Devices must be absent.
6. Search Settings for `diagnostics`; assert Diagnostics is the only visible
   result. Press Escape once to clear the query and again to return to the app.
7. Directly load `/agents`; assert HUI replaces it with `/` and
   renders Home. Directly load a retained capability and a Settings path and
   assert reload preserves each route.

## Narrow journey

Repeat at 390x844 and at landscape 844x390:

1. Open `/`; assert **Open navigation** is present and the sidebar is not in
   the accessibility tree.
2. Open the drawer, select **Sessions**, and assert the drawer closes while the
   route becomes `/sessions`.
3. Reopen the drawer and press Escape. Assert it closes and focus returns to
   **Open navigation**.
4. Open `/settings/models`; assert **Open settings navigation** is present.
   Open it, select **Diagnostics**, and assert the drawer closes, the route is
   `/settings/diagnostics`, and focus moves to the Diagnostics heading.
5. Assert `document.documentElement.scrollWidth === innerWidth` and
   `.main.scrollWidth === .main.clientWidth` on the capability shell.
6. While either drawer is open, assert the obscured main region has `inert`;
   after Escape, assert `inert` is removed and focus returns to the labelled
   drawer trigger without leaving the current route.
7. Open each drawer at 390x844, resize to 1440x900, and synchronize on
   `data-open="false"`. Assert the now-visible desktop workspace is no longer
   `inert`.

Finish by taking desktop and narrow screenshots and checking Browser page
errors. Do not replace visible interactions with direct API calls.

## Observed execution — 2026-09-22

Executed against `http://localhost:5173/` using the managed Browser tab `t2`.

- Desktop direct navigation, Settings filtering, dropped-route normalization,
  and History API back/forward all passed.
- Portrait 390x844 and landscape 844x390 drawers started closed, opened through
  their labelled controls, made the obscured workspace inert, closed on
  selection/Escape, and returned focus. Settings Escape in landscape retained
  `/settings/models` rather than leaving Settings.
- Opening Settings from Activity and activating **Back to app** returned to
  `/activity` instead of Home or a stale selected session. A
  subsequent browser Back did not reopen Settings.
- Resizing an open app or Settings drawer from 390x844 to 1440x900 closed the
  drawer and cleared `inert` after the media-query change event.
- Both narrow viewports measured zero document and main horizontal overflow.
- Desktop and portrait screenshots were inspected; the 258 px sidebar, 58 px
  topbar, overlay/backdrop, pinned footer and constrained page container rendered.
- Browser page-error list was empty. Two historical Vite connection errors in
  the persistent tab predated this run; after navigation there were no current
  JavaScript exceptions or failed HUI requests.
