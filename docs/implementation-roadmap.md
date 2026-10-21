# HUI implementation roadmap

This plan turns the measured OpenClaw Control UI surface into small, verifiable
increments. The routed pages live in `src/lib/pages.ts`; each has a real renderer.

## Agreed scope

- **Keep:** About, Labs, Profile.
- **Adapt to PI/HUI:** Activity, Config, Connection, Cron, Debug, Logs,
  Memory Import, Model Providers, Model Setup, New Session, Plugin, Plugins,
  Sessions, Skill Workshop, Skills, Tasks, Usage and Worktrees. Chat and PI
  questions live in the session view rather than separate pages.
- **Remove:** Agents, Approval, Approvals, Apps, Channels, Cloud Workers,
  Custodian, Dashboards, Device, Devices, Lobsterdex, Meetings and Portals, and
  the never-implemented Chat, Permissions, Question and Secrets page shells.
- Pages are served at `/<page-id>` (for example `/skills`). The former
  `/capabilities` catalogue and its placeholder shells were removed; the
  measured OpenClaw parity data lives in `docs/control-ui-coverage.md`.
- HUI stays in **Full Access**. It will not expose an approval inbox, approval
  prompts, or an agent-management page.

Settings follow the same rule: keep Appearance; adapt Connection, Sessions,
Models, Tools, Skills, Automation, Plugins, Memory, Security and Diagnostics;
remove Channels and Nodes / Devices.

## Bot reliability follow-up

- Routine delivery recovery and visible failure state: persisted dispatch
  checkpoints, Durable request deduplication and submission outcomes, safe
  pre-dispatch worker retries (three attempts within one deadline), exact
  cancellation and shutdown detachment. Temporary run counts survive retries.
  Browser proof and final validation are tracked in
  `e2e/bot-routine-recovery.browser.md`; not considered complete until that
  journey and the boundary checks pass.

## Session architecture: HUI ↔ PI

The browser never talks to PI directly:

```text
browser ──HTTP + fetch/SSE──> HUI gateway ──JSONL stdin/stdout──> pi --mode rpc
                                  │
                                  ├── HUI metadata: ~/.config/hui/sessions.json
                                  └── PI transcript: ~/.pi/agent/sessions/**.jsonl
```

1. One HUI session id maps to at most one live `pi --mode rpc` child process.
2. Creating a session persists the HUI record, spawns PI in the selected cwd,
   waits for `get_state`, records `sessionId`/`sessionFile`, and then announces
   `idle`. PI normally needs several seconds, so `starting` is a real state.
3. Opening a cold session starts PI with `--session <file>`, then calls
   `get_entries` to rebuild the transcript from the active branch. A gateway restart loses processes,
   not conversations; the next open resumes the PI file.
4. Prompts go through the HUI HTTP API. PI events are normalized by the runtime
   adapter and streamed to the browser over authenticated fetch-based SSE.
5. `agent_end`, not `turn_end`, clears the busy state and triggers a history
   refresh. Concurrent prompts return `409`. HUI exposes PI's explicit `steer`
   and `follow_up` commands, append-only tree navigation and native prompt-free
   continuation; it does not synthesize transcript messages for those actions.
6. HUI owns titles, groups, pins, cwd, chosen model and UI metadata. PI owns the
   transcript. Removing a HUI row never deletes PI's conversation file.
7. Full Access is inherited from the installed PI configuration. HUI adds no
   allowlist, sandbox switch or approval interception. Its only resource policy
   is explicit HUI-only skill enablement. Tool execution still appears in the
   transcript and diagnostics.
8. Every `/__hui/*` route keeps the `x-hui: 1` guard. Credentials are never sent
   to the browser; provider names may be reported, secret values may not.

## Iterative tasks

### Portable verification generator (2026-09-26)

- Bundle `create-verification-skill` as an optional, enabled-by-default HUI skill,
  tagged **good practices**, for generating project-specific verifiers.
- Reuse the Skills/Settings toggles and existing `disabledSkills` preferences;
  preserve opt-out across installation moves without writing PI-owned files.
- Include the same portable content, references and license in source and archive
  builds; expose it to SDK and CLI sessions after user/project/package resources.
- Runtime, package and browser verification evidence belongs in the implementation
  PR; completion is not asserted until the real UI has been exercised.

Each task should ship independently, leave the app usable and finish with
typecheck, tests, build and a rendered browser check.

### HUI-00 — Scope and parity baseline (done; remeasured for 2026.9.5)

- Measure OpenClaw 2026.9.5: 40 pages, 361 distinct chunks and 27 searchable
  Settings targets.
- Keep the navigable route catalogue and Settings inventory synchronized with
  the installed reference bundle.
- Record keep/adapt/remove decisions and use the reduced scope as the future
  functional-coverage denominator.

### HUI-01 — Freeze the PI session contract (done)

- Reconcile `SPEC.md`, `docs/api.md` and the current adapter with the session
  architecture above.
- Add contract tests for create → ready, reopen/resume, prompt → `agent_end`,
  crash/reopen, duplicate open and concurrent prompt rejection.
- Document restart semantics and the ownership boundary for every persisted
  field.

**Done when:** the contract can be implemented or refactored without guessing
how a browser session maps to a PI process or file.

Completed with deterministic lifecycle/concurrency tests and Browser E2E for
create → ready → models → delete. A successful generated reply remains an
environmental proof gap until the configured PI provider has credentials; HUI
correctly surfaces that provider error without retaining stale UI state.

### HUI-02 — OpenClaw shell parity (done for the primary shell)

- Port the sidebar, top bar, responsive breakpoints, page container, search and
  Settings workspace using the reference class vocabulary and tokens.
- Remove navigation entries for all dropped capabilities.
- Add direct route state so reload/back/forward preserve the selected page.

**Depends on:** HUI-00.
**Done when:** desktop and narrow screenshots match the reference regions, and
every retained capability is reachable without the catalogue.

The original primary-shell milestone was implemented against 2026.9.4. The
2026-09-24 pass pins presentation to 2026.9.5, removes competing legacy CSS,
and retains its 258 px desktop sidebar and platform-aware 900 px drawer query.
Browser verification covers desktop, portrait and landscape without overflow.
The stricter, separately tracked [visual goal](visual-parity-goal.md) is not
equivalent to this historical functional milestone; source/cascade checks alone
do not certify 100% original-app pixel parity.

The final checkpoint adds original composer/effort/textarea render proofs across
five states and three sizes, original switch checks, 48 pinned shared icons and
64 original file assets. It also fixes resize-stale textarea heights, the mobile
Effort gauge, single primary send/stop slot and native-popover inherited colors.
The independent follow-up additionally proves palette evaluation, Settings
primitives, session rows and plain-message/copy-menu rendering. It corrects
Rosé/contrast ink, switch label spacing, inline pin/title marquee anatomy and
the extra user-message footer action. See the visual goal for unproven regions;
functional E2E coverage is not a whole-app pixel certificate.

The transcript follow-up additionally compares Markdown and code reveal/wrap
states, compact sent-file cards, read output and command terminals against the
original renderers. Read/command rows no longer use generic JSON details.
The authorized Web Awesome 3.12.0 follow-up replaces the approximated settings
pickers/switches/selects, hub tabs and action menus. Its 544 original control-part
records and repeated 108-route sweep are documented in the
[Browser report](../e2e/webawesome-controls.browser.md).
Remaining tool kinds, capability layouts and untested control states still gate
full visual acceptance.

The owner-requested sidebar-header follow-up moves session search and Settings
to the left of the fixed header, with collapse/new session on the right. Search
opens directly below that row; the Sessions toolbar no longer duplicates it and
the old Settings footer is removed. Desktop, mobile, keyboard, filtering and
short-landscape scrolling checks are recorded in the
[Browser report](../e2e/sidebar-toolbar.browser.md).

### HUI-02a — Settings parity

**Status:** in progress.

- Done: the OpenClaw Appearance hierarchy for theme, accent, independent
  interface/chat-prose typography, text size and functional Chat preferences.
  The full ten-choice font catalogue is self-hosted and the former single-font
  setting migrates without changing an existing installation's appearance.
  Desktop/mobile and persistence proof:
  [independent font preferences](../e2e/font-preferences.browser.md).
- Done: the native Miami palette from OpenClaw 2026.9.5, including light/dark
  variants, system-mode switching, saved selection and accent overrides.
  Desktop/mobile and keyboard proof: [Miami Browser report](../e2e/miami-theme.browser.md).
- Done: message width, task-progress collapse and Enter shortcut persist through
  HUI settings and drive the real chat UI.
- Next: portable Sidebar/session-source preferences, then PI-backed model
  behavior and runtime/session defaults.
- Excluded by product decision: device-native settings, channels, Gateway
  secrets/auth, and approval/tool-policy controls that would contradict HUI's
  PI-owned Full Access contract.

### HUI-03 — Session registry and lifecycle (done)

- Finish Sessions and New Session against the HUI registry.
- Cover groups, pin, rename, delete-without-transcript-deletion, search and
  `starting/running/idle/error` states.
- Make reopening after a gateway restart transparently resume the PI file.

**Depends on:** HUI-01, HUI-02.

Completed with functional Sessions and New Session routes, grouped registry
search, pin/rename/regroup, session-scoped dialogs and attachments, the four
live lifecycle states, transactional PATCH/DELETE handling, and transparent
PI resume after a gateway restart. Browser E2E covered a real restart on the
same URL and proved that deleting HUI metadata leaves the PI file untouched.

The 2026-09-24 launch regression accepts namespaced gateway model IDs without
rewriting them. Failed launches retain the draft and show an accessible,
theme-aware callout aligned with the composer. Desktop/mobile Browser proof,
keyboard retry through real PI, and contrast measurements are recorded in
[`e2e/session-launch.browser.md`](../e2e/session-launch.browser.md).

The 2026-09-28 naming follow-up matches OpenClaw 2026.9.6's descriptive title
contract: three to six words, at most 60 characters, in the first message's
language. Stored titles keep their context while the sidebar handles visual
overflow. Utility-model and failure fallback coverage plus real-PI desktop and
mobile proof are recorded in
[`e2e/session-title-generation.browser.md`](../e2e/session-title-generation.browser.md).

The 2026-09-24 sidebar follow-up adds a permanent New Group entry, including
when only OTHER exists, and a functional Filter & Sort menu. Browser-local
grouping, sorting, live-status and empty-group preferences preserve the registry
format. Group labels are uppercase, with OTHER last; new groups are revealed
after a confirmed save. Desktop, portrait and landscape journeys, keyboard
controls, persistence and a real PI session in a newly created group are recorded
in [`e2e/session-groups.browser.md`](../e2e/session-groups.browser.md).

The 2026-09-24 session multiplexing follow-ups first kept independent
gateway-owned turns alive across navigation and added one gateway-wide lifecycle
SSE. The multiplexer now ports the installed OpenClaw 2026.9.5 column/stack
model: all four edge splits, center replacement, focused-pane controls,
same-session splits, horizontal/vertical resizing, browser-local persistence
and mounted narrow-layout views. Any pane can close without restarting its
survivors. The row menu retains an accessible **Open in split pane** fallback.
The model is compared independently against the installed reference by
`e2e/probes/session-multiplexer-oracle.mjs`. Sidebar status for unmounted
background sessions still settles without opening a full transcript stream for
every chat. Deterministic routing/view coverage and a real-PI simultaneous-turn
desktop/mobile Browser journey are recorded in
[`e2e/session-multiplexing.browser.md`](../e2e/session-multiplexing.browser.md).

The 2026-09-25 pane-placement follow-up adds header dragging for existing chat
and terminal views: edge relocation, center swapping and a keyboard move handle.
Stable flat pane hosts preserve live views across column/stack changes; resizing
retains the reference's minimum sizes and adjacent-weight contract. No new
dependency, server route or persistence format is introduced. Browser proof
and reference scope are recorded in
[`e2e/pane-reposition.browser.md`](../e2e/pane-reposition.browser.md).

The session-organization follow-up also ports OpenClaw's two move paths: native
row drag/drop onto custom groups and keyboard/touch **Move to** menu actions.
Project groups remain read-only projections. Both paths use the existing atomic
session metadata PATCH and expose pending, success and failure feedback.

The menu-parity follow-up replaces the flattened row actions with OpenClaw
2026.9.5's compatible hierarchy: pin, rename, read state, archive/restore,
icon, group placement, copy link/Markdown/ID, open in tab/window/editor
and delete. Archive/read/appearance are durable HUI metadata; archived rows are
restorable from Sessions. `Assign to` remains excluded because PI has no owner
model, and the row menu's fork remains excluded: PI exposes no fork RPC and
its JSONL is externally owned. Pi Durable sessions later gained a fork from a
reply in the transcript instead (SPEC Part 1). Desktop/mobile Browser proof is recorded in
[`e2e/session-menu-parity.browser.md`](../e2e/session-menu-parity.browser.md).
The picker follow-up restores OpenClaw's custom-emoji entry and uses centered
SVG reset controls for both color and icon instead of typographic crosses.

### HUI-04 — Chat and composer (done)

- Port transcript groups, Markdown, thinking, attachments, model/thinking
  controls, stop, copy and error states.
- Render complete tool start/end cards with output and failure state.
- Adapt Question to PI/HUI request-for-input events if PI exposes them; otherwise
  keep the route disabled and document the protocol gap.
- Decide and implement UI semantics for PI `steer` and `follow_up`.

**Depends on:** HUI-01, HUI-03.

Completed with discriminated durable transcript entries, in-flight replay,
atomic SSE snapshots, correlated tool progress/failure, Markdown/copy,
steer/follow-up queues, persisted thinking control, PI extension questions,
abort/recovery and bounded immutable uploads. Browser E2E used real PI against
a deterministic local provider with no operator credentials and covered live
streaming, reload during a turn, attachments, both queue modes, Question
answer/cancel, durable provider/tool failures, and portrait/landscape layouts.
The reproducible evidence is in `e2e/chat-composer.browser.md`.

The interrupted-run follow-up journals only the active prompt until PI settles
and projects a stale journal as recoverable after gateway/process loss. Gateway
startup now resumes those records automatically with a three-admission budget;
the recovery prompt verifies transcript and workspace state before repeating an
unknown effect, while **Continue run** remains the exhausted-budget fallback.
Settled background sessions persist OpenClaw's accent unread marker until opened.
A real gateway restart, PI continuation and responsive proof are recorded in
[`e2e/interrupted-recovery.browser.md`](../e2e/interrupted-recovery.browser.md).

The PI-backed behavior above remains authoritative. Chat, tool rows, thinking,
queue and composer now use the OpenClaw 2026.9.5 hierarchy and measured desktop
and mobile geometry. Model and thinking share an exclusive composer popover;
thinking uses OpenClaw's compact dotted Effort scale, previews changes while the
thumb moves, and remains available on narrow screens. OpenClaw's separate Fast
mode row stays absent because PI exposes no equivalent runtime setting.
The bundled `progress_card` PI extension persists explicit plan updates in the
runtime transcript and renders their latest validated state above the composer.
The session list now ports the original OpenClaw 2026.9.5 hovercard source, CSS,
positioning and interaction lifecycle; background updates retain the same PI API.
Independent original-render comparison matches structure and all 13 measured
regions in light/dark themes. See [hovercard browser proof](../e2e/session-hovercard.browser.md).
The bundled `present_media` extension gives agents an explicit media-output
contract: opaque HUI-hosted artifacts persist through PI tool-result details,
images paint inline, native audio/video controls support byte-range seek, and
other formats remain downloadable. Its active-tool prompt guidance tells the
agent exactly which formats HUI can paint instead of relying on guessed HTML or
unreachable local paths.
The transcript's declarative rich-output subset now also includes strict,
lazy-loaded Mermaid fences and consent-gated embeds for isolated X/Twitter post
URLs. Turn-time prompt guidance advertises those exact forms. Labeled/inline
links remain links, third-party code does not load before consent, and arbitrary
HTML/SVG/iframes remain outside the contract.
The next rich-output pass adds lazy KaTeX math, semantic GitHub callouts and
self-contained Vega-Lite charts. A structured presentation catalog generates
the stable prompt section, while PI's selected tool snippets/guidelines remain
the authoritative live tool catalog. This keeps presentation syntax separate
from callable tools and leaves progressive search/describe/call disclosure as a
future optimization only if the HUI-owned tool surface becomes materially large.
Canonical Slack message and channel permalinks now have a smaller static-card
contract: isolated links from either participant show link-derived identity and
an external action, with no OAuth, API call, private-content preview or new
persisted format. Prompt guidance explicitly separates rendering that card from
having a Slack-reading tool.
The composer also ports OpenClaw's supported input behavior: bounded auto-grow
with internal scroll fades, surface-to-editor focus, file drag/drop state, image
clipboard attachments, and long pasted text as a file. Dictation is intentionally
absent because OpenClaw implements it through Gateway `talk.session.*` APIs that
the PI runtime contract does not expose; HUI does not render a non-functional mic.
Local paths complete from the workspace through a bounded read-only server route.
The cursor-aware menu supports `@` references and explicit relative, home, or
absolute paths while preserving the leading `/` command interaction.
Composer and navigation colors follow OpenClaw's semantic roles directly: the
composer uses the neutral `popover` surface and text-derived hairline, while the
accent is reserved for actions and selected navigation state. HUI does not tint
neutral surfaces by mixing `primary` into them.
New Session reuses that same composer DOM hierarchy and control classes rather
than maintaining a lookalike surface. Its submit control uses OpenClaw's arrow
SVG, 32px composer action token, disabled color ramp, footer spacing, and
superellipse capability scale.
New Session waits for the newly-created PI runtime to be
idle before releasing its initial prompt, preventing the previous startup 409.
Sessions and Appearance Settings also use the ported page-owned workspace
layouts. Appearance includes the OpenClaw accent presets, custom color and
theme-default reset as HUI-local presentation state. Browser evidence is recorded in
`e2e/openclaw-primary-ui-parity.browser.md`.

The 2026-09-24 conversation-position follow-up connects the already pinned
OpenClaw rail styles to HUI's rendered message projection. User prompts and
visible assistant responses have previews, visible/current markers and mouse
or keyboard jumps; tool/reasoning disclosures do not become false targets.
Long rails keep every marker, independently scroll, and preserve the reader's
position during streaming. Narrow/short layouts retain the original hiding
rules. No runtime, API, dependency or persisted-format changes are involved.
Browser proof with 200 seeded PI messages, a real streamed turn, session changes,
reload and responsive checks is recorded in
[`e2e/position-rail.browser.md`](../e2e/position-rail.browser.md).

The 2026-09-24 subagent follow-up ports OpenClaw's session coordination contract
to PI: spawn/list/history/send plus list/steer/kill lifecycle control. Spawned
work receives an independent persistent HUI/PI session, reports back to its
parent, remains limited to the same session tree, and appears in the copied
background-task activity rows plus nested sidebar sessions. A private
random-token loopback bridge keeps the tools out of the browser API. Focused
runtime/security tests and the real-PI Browser journey are recorded in
[`e2e/subagents.browser.md`](../e2e/subagents.browser.md).

The message-metadata follow-up adds editable quoted replies, relative message
and completion times, and per-model-call tokens/cache/cost plus observed
model/tool durations. Browser reload retains live measurements; runtime restart
retains only PI-owned usage/timestamps. No new persistence format is introduced.
Validation and responsive proof: [message metadata](../e2e/message-metadata.browser.md).

### HUI-04b — Shared terminal panels

**Status:** implemented; validation recorded in
[`e2e/shared-terminal.browser.md`](../e2e/shared-terminal.browser.md). Terminal
panes moved into the Work pane with HUI-21.

- Ghostty Web + gateway-owned PTYs + same-origin, one-use-ticket WebSockets.
- Terminal panes use the existing multiplexer, including independent splits,
  tab selection, hide/reopen, resize and the narrow-screen active-panel selector.
- PI's `terminal` tool shares the operator-opened shell through the authenticated
  agent bridge, with exact-conversation scope and bounded output.
- Tests cover native PTY input/Unicode/Ctrl+C, resource and ownership limits,
  reload/replay, forged/reused tickets and the installed standalone gateway.
- Shells survive browser disconnects, not gateway restarts. tmux and durable
  terminal logging remain outside this iteration.

### HUI-05 — Models, config and connection

**Status:** PI-backed projection and HUI-owned built-in provider connections.

- Adapt Model Providers and Model Setup from PI's model/auth metadata without
  exposing credentials.
- Adapt Connection to HUI gateway health and live PI process state.
- Split config ownership: PI files are read-only; HUI settings are writable.
- Keep Full Access fixed and visible; do not add approval controls.

**Depends on:** HUI-01, HUI-02.

The 2026-09-24 model-selection follow-up applies the operator's `models.json`
rules consistently to New Session, active-session switching and Models settings.
It preserves provider-only overrides and missing/malformed-file fallback without
rewriting PI configuration. Search matches multiple terms and full references;
an excluded default no longer bypasses an available configured launch choice.
Real PI returned 67 available fixture models; both pickers and Settings displayed
only the two configured IDs. Browser creation, keyboard selection, live switching,
desktop/mobile views and evidence are recorded in
[`e2e/configured-models.browser.md`](../e2e/configured-models.browser.md).

The 2026-09-27 provider follow-up adds HUI-owned built-in API-key/OAuth connections,
multiple selected models, catalog context/output limits and supported subscription
quota windows. Custom provider definitions remain in PI; HUI selections override
only explicitly managed provider IDs. Safe status/login routes never return saved
credentials. Tests cover persistence, cancellation, redaction, overlays and quota
parsing; Browser proof is tracked in `e2e/providers.browser.md`. The follow-up
add-provider modal groups OpenCode Go, OpenAI and Claude with their supported
login methods. Added connections show per-account plan/usage status and all reported quota
periods (including monthly and scoped limits); billing status stays explicitly
unknown when absent. Limits are visible without expanding a disclosure. Model
selection stays collapsed; disconnected cards show only sign-in. Custom setup UI is deferred,
without changing PI-owned custom configuration.

The multi-account follow-up adds named HUI accounts, durable ordering and
per-account quotas/removal, preserving the legacy credential with an Account 1 fallback label. Reported
OAuth emails now identify Codex/Claude accounts without merging same-email
subscriptions; OpenCode Go reads its 5-hour, weekly and monthly API-key quotas. SDK
requests pin credentials across async refresh, fail over on pre-output quota
rejection, and persist reset-aware cooldowns. Partial responses and tools are
never replayed. PI custom providers remain unchanged.
Tests include the real PI OpenAI HTTP adapter against a local 429/SSE server.
Browser proof is recorded in `e2e/providers.browser.md`.

The native Claude Code CLI runtime that followed was later removed; Claude
models remain available through PI's Anthropic provider.

### HUI-06 — Skills and extensions

**Status:** completed for discovery, bounded read-only resource viewing,
HUI-only resource enablement, package install/remove and agent-assisted skill installation. Package update and
Workshop publication remain disabled.

- Adapt Skills to all configured PI skill roots.
- Install catalog packages through PI's CLI and remove an exact configured
  source only after inline confirmation. Mutations are serialized and bounded.
- Install a skill URL through a short-lived low-cost PI agent; report OK only
  after PI discovers a new skill, otherwise report Error.
- Enable or disable installed skills for HUI runtimes without uninstalling them
  or writing PI configuration; apply the policy on the next runtime start.
- Enable or disable configured packages and direct extensions before SDK resource
  discovery. Disabling a package excludes all of its extensions, skills and
  prompt resources without rewriting PI settings.
- Read an inventoried skill's `SKILL.md`, package README/manifest or direct
  extension source through an opaque-id, size-bounded route that executes no code.
- Map Plugins/Plugin to PI packages and extensions.
- Adapt Skill Workshop only after its storage and publication boundary is
  specified.

**Depends on:** HUI-02, HUI-05.

The 2026-09-24 composer follow-up connects PI's live `get_commands` catalog to
the `/` menu, including workspace-local skills, extension invocation names and
prompt templates. Completion never auto-submits; New Session can explicitly
start a workspace to browse its catalog without a model call. Command-only
extension completion now settles correctly, including after extension questions.
The HUI-owned `/clear` command resets an idle chat through PI's native
`new_session` RPC while preserving the HUI row and the previous PI transcript.
Browser proof and protocol limits are recorded in
[`e2e/slash-commands.browser.md`](../e2e/slash-commands.browser.md) and
[`e2e/clear-command.browser.md`](../e2e/clear-command.browser.md).

The 2026-09-25 composer follow-up adds catalog-resolved `$` references for skills
and plugin actions, and combines leading `/` discovery with absolute-path
results in separated groups. Nested paths and `@` retain dedicated completion.
See [`e2e/command-references.browser.md`](../e2e/command-references.browser.md).

### HUI-07 — Memory and worktrees

**Status:** completed for read-only inventory plus explicit New Session checkout
selection and worktree creation. No OpenClaw memory is copied. Git mutation is
limited to checking out the selected current repository ref or creating a new
branch/worktree transaction; deletion and garbage collection remain absent.

- Adapt Memory Import to workspace memory sources without copying OpenClaw
  memory state.
- Adapt Worktrees to git plus HUI session metadata.
- Mirror OpenClaw's checkout picker, including current checkout, bounded base-ref
  suggestions and optional title-derived worktree names.
- Allow Current checkout sessions to start from a selected branch/ref by using
  Git's normal checkout safety.
- Create a worktree from the selected base ref with a configurable branch prefix
  and rollback when session registration fails.
- Prove path isolation and avoid writes outside the selected workspace.
- Group new-session defaults retain the optional Branch/Worktree mode and base
  ref, with backward-compatible registry fields; suffixes remain per-session.
  Verify persistence and both launches with the group journey.

**Depends on:** HUI-03.

### HUI-08 — Automation

- Done: HUI-owned persistence (`~/.config/hui/automation.json`), the `at`,
  `every` and `cron` schedules, create/edit/pause/resume/delete controls, manual
  runs, cancellation, run history and task status, plus the Automation settings
  region that drives them.
- The surface re-reads the snapshot while it is open, because run status settles
  in the scheduler after the mutation response.
- Automations and Tasks now route to that working UI instead of catalogue
  placeholders. All schedule kinds and lifecycle controls have Browser proof
  in the 2026-09-24 visual run.
- Next: webhooks and triggers, which have no HUI contract yet.

**Depends on:** HUI-03, HUI-05.

### HUI-09 — Observability

**Status:** completed with bounded, best-effort operational evidence.

- Activity, Logs and Debug use HUI gateway/session/runtime events retained in
  memory for the current gateway process.
- Usage aggregates numeric PI session metadata; unavailable cost remains
  explicitly unavailable and is never estimated.
- Diagnostic exports exclude prompts, transcript content, tool payloads,
  credentials and secret-shaped values.
- Warnings and errors keep their reported cause as a redacted, bounded
  `detail`: runtime start-up failures and exits, runtime and provider errors,
  failed model runs and failed `/__hui/` responses. The Logs subset is also
  written to the gateway's stderr, so `hui gateway logs` keeps it across
  restarts.
- The browser reports uncaught errors, unhandled rejections and `/__hui/`
  requests that could not connect, queued while the gateway is unreachable. A
  PI runtime that fails to start or exits adds the end of its stderr.
- Sessions now carries the operational slice needed while coordinating work:
  loaded runtimes, best-effort process-tree RSS, startup duration and the
  heaviest runtime, with the same telemetry on each live row. Measurements are
  ephemeral and unsupported hosts stay explicitly unavailable.

**Depends on:** HUI-01, HUI-03.

### HUI-10 — HUI-owned surfaces

**Status:** completed as HUI-owned presentation state.

- About, Labs and Profile have real routes without an OpenClaw
  backend.
- Experimental flags and profile presentation fields persist only in HUI
  settings.
- Sessions and Privacy & Security settings report the existing HUI/PI ownership,
  retention, access and credential boundaries instead of placeholder copy.
- Dashboards was subsequently removed: its widgets duplicated the dedicated
  operational surfaces without providing a distinct workflow.

**Depends on:** HUI-02.

### HUI-11 — Prune and release gate

- Delete route shells, settings entries and assets for all dropped capabilities
  (done: the capability catalogue and placeholder page shells are gone).
- Re-measure visual and functional coverage against the retained set.
- Run accessibility, keyboard, responsive, reconnect and Tailscale-hosted smoke
  tests; update README and CONTRIBUTING.

**Depends on:** every retained task selected for the first release.

### HUI-12 — HUI-owned PI SDK backend and truthful Tools catalog

**Status:** implemented; verified with deterministic runtime and Browser tests.

- Pinned maintained PI SDK in a child process, with explicit CLI fallback and
  unchanged HUI registry / PI-owned transcript persistence.
- Shared HUI tool definitions and versioned default prompt; PI still loads user
  overrides, append text, project context and skills.
- Session-independent shipped catalog; configured sources are no longer counted
  as tools. Live inspection reports schemas, actual activation, diagnostics and
  initialized/current-turn/last-turn prompt provenance without booting cold chats.
- Runtime proof covers provider-bound schemas/prompt, extension loading/overrides,
  questions, queues, attachments, abort, model/thinking, compaction, worker death
  and CLI/SDK resume. [Browser proof](../e2e/sdk-backend.browser.md) includes desktop
  and mobile Tools, real tool calls, questions and session coordination.
- Future: explicit disposable workspace discovery, a prompt editor, and individual
  tool replacements. No PI fork or new approval surface was introduced.

**Depends on:** HUI-01, HUI-03, HUI-05.

### HUI-13 — Installable production gateway and CLI

**Status:** implemented; package and Browser verification recorded in
[`e2e/package.browser.md`](../e2e/package.browser.md).

- Local npm archive contains compiled CLI/server/SDK worker, web assets, themes
  and the pinned dependency graph. Production does not require Vite or global PI.
- `hui gateway start|stop|restart|status`, foreground run, bounded logs and
  `hui ui` share authenticated process identity and serialized lifecycle control.
- Normal shutdown refuses active work; explicit force interrupts it. Restart
  resumes existing PI transcripts without changing their persisted format.
- Local `hui update --from` validates and probes a staged release, activates it
  atomically, and restores the previous release/gateway on failure. Rollback
  remains reachable through the original launcher. Host-managed/source installs
  are not rewritten; stopped gateways remain stopped.
- Linux install/lifecycle is verified with disposable state and a real SDK.
  Release signing, npm publication, boot service setup and
  macOS/Windows lifecycle certification remain future work.

The 2026-09-24 update follow-up adds a GitHub Releases channel with
mandatory checksum verification, version-pinned
activation, `hui update --check`, and a tag-triggered CI publishing workflow.
`/update` and `/update --check` are HUI-owned composer commands available even
without a session. Their dialog shares the transactional CLI updater through a
detached worker, retains a restart-surviving receipt, and never prompts PI or
forces active work to stop. No tag or first release is published by a code push.
Verification and external-service proof limits: [`e2e/update.browser.md`](../e2e/update.browser.md).

The automatic-notification follow-up checks on opening and hourly while the UI
is visible/online, using a gateway-owned cache shared across tabs. A dismissible
version-specific banner opens the same explicit install dialog, preserves
drafts, and remains keyboard/mobile accessible. No host scheduler, model call or
automatic installation is introduced. Fake-clock/cache tests and installed
Browser-tool update/reload proof are recorded in
[`e2e/update-notice.browser.md`](../e2e/update-notice.browser.md).

**Depends on:** HUI-01, HUI-03, HUI-12.

### HUI-14 — Jira Cloud work items

Done 2026-09-25. Settings → Integrations → Jira connection (site, email, API token, default
project), session row mark and hovercard, and a create dialog with utility-model
drafts for parent, summary and description. Proof: `server/integrations/jira.test.ts`,
`src/lib/jira.test.ts`, and `e2e/jira-integration.browser.md`.

Follow-up 2026-09-25: Settings → Integrations → GitHub signs in through the
gateway's `gh auth login --web` device flow (code, copy, device link, Connected
on approval) and reports a missing `gh` as required. Proof:
`server/integrations/github.test.ts`, `src/lib/github.test.ts`, and
`e2e/github-integration.browser.md`.

Follow-up 2026-09-25: chat messages unfurl up to three GitHub repository, pull
request and issue previews through `gh api`, and PR badges use the same lookup.
Proof: `server/integrations/github-previews.test.ts`, `src/lib/markdown/github-links.test.ts`,
`src/lib/github-previews.test.ts`, and `e2e/github-embeds.browser.md`.

Follow-up 2026-09-30: removed the chat's changes card, its `propose_changes`
tool and the Settings → Integrations → Git toggle; agents commit and open pull
requests themselves when asked.

Follow-up 2026-10-16: chat messages unfurl up to three Datadog share links and
dashboard links, with widget graphs drawn by Datadog's graph snapshots, through
several Datadog orgs: Settings → Integrations → Datadog keeps a list of `pup`
sessions and sites, and runs `pup auth login` from Settings or a card. Proof:
`server/integrations/datadog.test.ts`, `server/integrations/datadog-previews.test.ts`,
`src/lib/markdown/datadog-links.test.ts`, `src/lib/datadog.test.ts`, and
`e2e/datadog-embeds.browser.md`.

### HUI-15 — Managed browser tool

Done 2026-09-28. The HUI-owned `browser` tool gives PI sessions a dedicated,
headless-by-default Chromium-family browser with its own HUI profile, driven over
a private DevTools pipe without new dependencies. Tabs are scoped to the opening
conversation; agents act on accessibility-snapshot refs with real input events.
Settings → Tools → Browser turns the tool off, switches to a visible window, sets
the executable, starts/stops the process and previews open tabs. Proof:
`server/browser/*.test.ts` (including a real headless browser when one is
installed), `server/routes/browser.test.ts`, `server/runtimes/pi-sdk.test.ts`,
`src/lib/browser-status.test.ts` and `e2e/browser-tool.browser.md`.

Follow-up 2026-09-28: while the agent browses, the chat shows a live preview of
its page under the latest browser activity (following the agent's tab, marking
clicks and naming each action), and a browser panel beside the chat opens from
it; both stream from a CDP screencast only while watched. Proof:
`server/browser/manager.test.ts`, `server/browser/transport.test.ts`,
`src/lib/browser-view.test.ts`, `src/lib/browser-view-controller.test.ts`,
`src/views/chat/projection.test.ts`, `src/lib/session/multiplexer.test.ts` and
the live view section of `e2e/browser-tool.browser.md`.

Follow-up 2026-09-29: the managed browser survives being killed behind the
gateway's back (an operator cleanup script, a crash, or another Chromium
process holding the shared HUI profile). An `open` that finds the dead process
relaunches it instead of writing to the closed pipe, another action caught by
the kill says the browser exited and to open again instead of surfacing a
protocol error, and a launch that loses the profile to another process reports
that instead of "The browser connection closed." Proof:
`server/browser/manager.test.ts`.

### HUI-16 — macOS sleep prevention

Settings → Gateway → Power keeps a macOS gateway host awake (`caffeinate -i`, on
by default) and optionally awake with the lid closed (`pmset -a disablesleep`,
one administrator prompt per enable, never saved, so every gateway start begins
off without prompting). Both end with the gateway, including a crash; a reboot's
leftover shows as on until turned off. A top notice reminds while the lid is
held awake. Proof: `server/power.test.ts` (real watcher script against fake
macOS commands), `server/routes/power.test.ts`, `src/lib/settings/settings.test.ts`,
`src/views/settings-gateway.test.ts` and `e2e/power-settings.browser.md`.

### HUI-17 — Background watchers

Done 2026-10-02. Sessions run long waits (a pull request approval before
`/merge`, a CI run, a deploy) through the HUI `watcher` tool instead of
detached `nohup` scripts. HUI starts the command detached in its own process
group, keeps one log and exit record per watcher, derives
running/done/failed/stopped/dead from the process identity (a reused PID after
a reboot reads dead), and lists them in the owning conversation as compact
background-activity rows that open into details, a log tail and stop, restart
and dismiss controls. The registry survives gateway
restarts. Proof: `server/agent-tools/watchers.test.ts`, `server/routes/watchers.test.ts`,
`src/views/chat/watcher-activity.test.ts` and `e2e/watchers.browser.md`.

### HUI-18 — Bots with OptChat memory

Product decision approved by the owner on 2026-10-05 (SPEC.md, "Bots are named
chats, not an agent selector"): GrokBot/Hermes-style bots beside sessions. The
sidebar splits into **Agents | Bots**; sessions stay as they are. A bot is a
named Durable conversation that never ends, with a role, a SOUL.md persona it
writes in its first conversation, its own model and directory; its memory is
[OptChat](optchat.md): every message
is kept in an append-only log, a cheap model compresses it into a tree of
one-line summaries, and every turn starts fresh from a bounded view of the
whole chat. `hui bot` can do everything the Bots tab can, through the same
routes. Routines are Automation tasks aimed at a bot's chat; bots message each
other; you can call them, through GPT-Live. A bot runs on the local gateway or,
chosen when it is created, on a remote worker (item 6). It lands as stacked pull
requests:

1. **OptChat memory for Pi Durable conversations** — done 2026-10-05. The engine
   (`server/optchat/`) and its Durable integration
   (`server/runtimes/durable-optchat.ts`): a conversation whose `hui.optchat`
   document is enabled projects its entries into the log, starts every request
   fresh from a view frozen per run, offers `zoom` and `date`, declines Durable's
   compactions and marks Anthropic cache breakpoints in its view; every other
   conversation is unchanged. No UI, route or CLI yet, so no Browser-tool proof
   applies. Proof: `server/optchat/*.test.ts` and
   `server/runtimes/durable-optchat.test.ts` (deterministic provider: unchanged
   plain requests, fresh turns, a frozen view across a tool loop and a restart,
   zoom and date, declined compaction, catch-up without duplicates, waiting for
   summaries and Stop). Cache fix 2026-10-08, after the recipe's corrected
   revision (`3c190e0`): the view merges the pair that ended longest ago in its
   own line size, appends only between batches (past 128 KB one batch merges it
   down to 64 KB), is saved in `view.json` instead of folded again at every open,
   compactions read a 16-32 KB view of their own, and both views go to Anthropic
   in 4-line blocks marked on the last whole one (docs/optchat.md, "The view" and
   "Prompt caching"). Proof: `server/optchat/view.test.ts` (Taelin's `push` merge
   for merge, the sawtooth, a batch deferred by unbuilt parents),
   `view-file.test.ts`, `memory.test.ts`, `cache.test.ts`, `replay.test.ts`
   (3,000 messages: 96.5% of each turn's view unchanged, 95.8% read from the
   cache) and `server/runtimes/durable-optchat.test.ts`.
2. **Bots backend and `hui bot`** (implemented 2026-10-05; browser proof
   with item 3): `bots.json` registry and `shared/bots.ts` types; bot chats as
   ordinary Durable sessions whose conversation is created with its persona,
   `hui.bot` document and OptChat in one commit; edit (an empty model or
   thinking level goes back to the gateway defaults), archive (routines
   disabled, nothing deleted) and restore; `/__hui/bots` routes with messages
   (prompt or follow-up, optional wait for the answering run), stop, memory and
   an events stream; forever-chat refusals of clear, compact, rewind and
   delete; routines marked `[routine: <name>]` and queued behind a busy bot;
   `message_bot` and a byte-stable `bots` section only in bots' chats, with a
   three-hop loop guard and an hourly limit; the `hui bot` CLI with streamed
   `chat` (what the bot gets from elsewhere shown before its reply, since the
   chat's stream announces each prompt it accepts), `send --wait` exit codes
   and routines. OptChat reaches bots through the `BotMemory` port only, whose
   adapter (`optChatBotMemory`) maps it onto the engine: a bot's chat has its
   memory from its creating commit, and the memory routes and `hui bot memory`
   read its status (with view lines and the compactor's usage), view, zoom and
   browse page, which a same-origin link opens. Proof: `server/bots/bots.test.ts`,
   `server/bots/service.test.ts`, `server/routes/bots.test.ts` (a real gateway
   with a deterministic provider: routes, guards, a waited reply, a bot-to-bot
   message, a routine, the events stream, real OptChat memory with built
   summaries, the view, zoom down to a whole message and the page under its
   same-origin rule, clearing the model and thinking, and `hui bot chat`
   showing a message from elsewhere and a routine before their replies),
   `server/bots/durable.test.ts` (requests of plain conversations
   unchanged; a bot conversation's commit, persona, section and tool; with the
   real adapter, OptChat on in the creating commit, zoom and date beside
   `message_bot`, a fresh second turn and every read),
   `server/live-sessions.test.ts`, `cli/main.test.ts` and `cli/bots.test.ts`
   (a fake gateway and a scripted terminal).
   **After review (2026-10-06):** instructions became SOUL.md plus a first
   conversation (SPEC.md, "Bots write their own SOUL.md in a first
   conversation"). Every bot has a home folder with its SOUL.md, rendered as
   the last prompt section (`soul`) on every request through a resolver the
   host provides; without it the section is the first conversation, and a bot
   created without a soul gets a kickoff turn so it speaks first. `soul` on
   create, `GET`/`PUT /__hui/bots/:id/soul`, `BotView.soul` (cached per chat
   state), the `BotSouls` port, delete removing SOUL.md, a one-time migration
   of existing instructions, and `hui bot add --soul-file` / `hui bot soul`.
   The bot saves SOUL.md with a bot-only `write_soul` tool (no file tools
   needed), and a bot without its own model starts on Settings' primary model,
   as new sessions do, instead of PI's catalog default. Then (owner's
   answers): a bot created without a name is *New Bot* and names itself in its
   first conversation with a bot-only `set_profile` (a derived handle follows
   the name), and delete works on active bots too and removes the bot's whole
   folder and its OptChat memory (the raw Durable log stays: pi-durable cannot
   delete conversations), `hui bot delete` asking first or taking `--yes`.
   Proof: `server/bots/bots.test.ts`, `server/bots/service.test.ts` (kickoff,
   soul routes, cache, migration, delete), `server/bots/durable.test.ts`
   (the section in real requests, the first conversation's text, truncation, a
   host without a resolver), `server/routes/bots.test.ts` (a real gateway: the
   first turn starts by itself, the bot writes SOUL.md with its write tool and
   the next request carries it, the routes and guards), `cli/*.test.ts`.
3. **Bots tab** (UI; done 2026-10-05): Settings → Sessions → *Show the Bots
   tab* (off by default); the Agents | Bots switch in the sidebar's top row
   (renamed from Sessions | Bots and moved there on 2026-10-06, beside the
   collapse toggle; Bots shows only the roster); bot chats filtered from
   every session list and picker; the roster (activity order, search, unread,
   badges, New bot, Edit, Hide/Unhide, Archive with Restore, *Show archived*
   with Restore and Delete) fed by `/__hui/bots/events`; the dialog's *Gateway default*
   for the model and thinking level (clearing them on edit); `/bots/<id>`
   rendering the bot's chat in the ordinary session pane without `/clear`,
   `/compact` or rewind; the Routines | Memory panel (a sheet on narrow
   screens), whose Memory tab shows the memory's stats and summarizer spend,
   follows the bots stream while open, zooms a line down to its message and
   links the memory page; bot routines' schedules worded on the Automations
   page as in the panel. Proof: `src/lib/bots/bots.test.ts`,
   `src/lib/bots/roster.test.ts`, `src/lib/bots/routines.test.ts`,
   `src/lib/bot-memory.test.ts`, `src/lib/navigation.test.ts`,
   `src/lib/settings/settings.test.ts`, `src/lib/composer/slash-commands.test.ts`,
   `src/views/settings-automation.test.ts` and the Browser-tool journey
   `e2e/bots.browser.md` (create, chat, routine with Run now, real OptChat
   memory live in the panel with *Summarizing memory…*, zoom to a message, the
   memory page, Gateway default, hide, archive, Show archived and Restore, lists
   without the bot chat, desktop, mobile and landscape).
   **After review (2026-10-06):** the dialog lost Instructions (New bot says
   the bot starts by asking what you expect), the panel became Routines |
   Memory | Soul (SOUL.md as Markdown with Edit, *Write it yourself* before the
   bot wrote one, followed live from the bots stream), and HUI's kickoff of a
   new bot shows as a note, *<name> was created*. Proof:
   `src/views/bot-soul.test.ts`, `src/views/chat/projection.test.ts`,
   `src/lib/bots/bots.test.ts`, `src/lib/bots/roster.test.ts` and the Browser-tool
   journey in `e2e/bots.browser.md` (screens in PR #69).
4. **Voice through VoiceStudio** — dropped on 2026-10-06 before it merged: the
   owner removed VoiceStudio, so calls run on GPT-Live only (item 5) and voice
   notes, Read aloud and VoiceStudio voices are gone. The call screen it built
   (the call view, its minimized bar and the app's one call) moved to item 5,
   with Durable streaming the text it sends whole to the live view.
5. **Calls with GPT-Live** (implemented 2026-10-06; tested with real calls
   through a ChatGPT login): the bot header's Call, offered with a ChatGPT
   login; the call view (the bot's face listening and speaking, a timer,
   captions, Mute, Speaker, Hang up) and its minimized bar; Settings → Models →
   Calls (the default voice, the ChatGPT login calls use) and a per-bot call
   voice and language (`voice.live` and `voice.language`, `--call-voice` and
   `--language`). The gateway's broker
   (`server/bots/calls.ts`, `server/routes/calls.ts`) sets each WebRTC call up over
   the ChatGPT login without the browser seeing a token, picking accounts as
   model turns do. The browser's `LiveCall` (`src/lib/voice/live-call.ts`) carries
   the audio and data channel. OpenDots-style: GPT-Live's one tool asks the bot's
   call helper on its utility model (`server/bots/call-helper.ts`). The helper hands
   real work to the chat as `[call task]` messages, whose replies are spoken
   while the call lasts. Each call ends as one card with a summary and the whole
   transcript, which the bot's memory keeps. The bot's Memory model became its
   Utility model, defaulting to Settings' utility model. Settings and `bots.json`
   saved while VoiceStudio was there keep loading, and the next write leaves its
   fields out. Proof: `server/call*.test.ts`, `server/bots/calls.test.ts`,
   `server/bots/service.test.ts`, `server/routes/bots.test.ts`, `server/bots/bots.test.ts`,
   `server/runtimes/durable-optchat.test.ts`, `server/runtimes/durable.test.ts`,
   `src/lib/voice/live-call.test.ts`, `src/lib/voice/*.test.ts`, `src/lib/settings/settings.test.ts`,
   `src/lib/bots/bots.test.ts`, `src/views/bots.test.ts`, `src/components/settings/calls.test.ts`,
   `cli/*.test.ts` and a real call run (both calls of the e2e in the pull request).
6. **Bots on remote workers** (implemented 2026-10-06; the owner's request, SPEC.md
   "Bots run on remote workers"): `BotInput.worker` (an id or name, at creation
   only; a `PATCH` naming one is 400), views name the worker, and the bot's
   conversation, folder and OptChat memory are created in the worker's Durable
   store by its host (`server/worker/host-bots.ts`, reusing `bot-conversations.ts`
   and `bot-memory.ts` against the host's own `DurableHost`). `BotService`
   picks the gateway's ports or the worker's (`server/bots/remote.ts`) per bot;
   lists read a remote memory's last reported status and never wait on a
   worker; an offline worker fails creates, memory reads and messages with a
   503 that names it, and a host from before bots is told apart (409). The
   worker's host asks the gateway for its bots' `bots` section, so
   `message_bot` crosses both ways. While a worker exists the roster's + is a
   menu, *New bot on Local* or on each worker, that creates *New Bot* there at
   once; the machine shows beside a remote bot in its row and header, read-only
   in its Settings tab (item 7); and `hui bot add --worker`. With SOUL.md (merged 2026-10-07) every
   bot on a worker has its home there, where its SOUL.md, first conversation and
   `write_soul` live; the Soul tab and calls read it through the host, and
   deleting removes that home there, or queues the removal on the gateway's
   machine (`~/.config/hui/bot-cleanup.json`) until the worker reconnects. A
   remote session's limits apply: no terminal,
   browser or watcher tools, no worktrees. Proof: `server/worker/host.test.ts`
   (the host's bot operations on a real host), `server/bots/remote.test.ts`,
   `server/bots/service.test.ts` (fake remote ports: routing, offline paths, a
   list that never waits), `server/bots/bots.test.ts`, `server/routes/bots.test.ts`,
   `server/bot-workers.test.ts` (a real local worker with the fixture provider:
   the remote store, a reply with the bots section, the utility-model compactor,
   `message_bot` both ways, a routine, a queued message, steering, a question,
   Stop, a call's record, archive, restore, delete and a disconnected worker),
   `src/lib/bots/bots.test.ts`, `src/views/bots.test.ts`, `cli/*.test.ts` and the
   browser journey `e2e/bots-workers.browser.md` (a built gateway with a local
   worker, headless Chromium through CDP; screenshots in the pull request).
7. **Bot setup like Grok Bot** (2026-10-06; SPEC.md, "Bots are set up like
   Grok Bot"): no form; + creates a bot at once, without a name, and opens its
   chat, where the bot (*New Bot* until then) asks what to call it; while a
   worker exists + is item 6's menu, and the bot is made on the machine chosen.
   The New bot and Edit dialogs are gone. A Settings tab in the bot's panel
   holds Profile (name, title and look, edited in place), Model, Calls (call
   voice and language; its head says when calls need a ChatGPT login) and
   Workspace (Runs on, the machine read-only while a worker exists, and the
   directory, with that machine's folder suggestions), each change saved on its
   own through the existing `PATCH`; Edit bot… in either ⋯ menu opens it, as
   does Ctrl+Shift+,; the panel's tabs moved to a row of their own under a
   header with the bot's name, with room for five. No API or CLI change. Proof:
   `src/lib/bots/bots.test.ts`, `src/lib/bots/roster.test.ts`,
   `src/views/bots.test.ts`, `server/routes/bots.test.ts` (a New Bot's
   opener) and the Browser journey `e2e/bot-setup.browser.md` (built gateway,
   fixture provider, a local worker, 1440×900, 1280×720 and 390×844, dark).
8. **Tools and skills per bot** (implemented 2026-10-07; SPEC.md, "A bot has
   every tool and skill until the operator turns some off"): every bot has
   every tool and skill a session in its directory has until the operator
   turns some off. `disabledTools` and `disabledSkills` live in the chat's
   `hui.bot` document (optional fields of version 1, mirrored in `bots.json`),
   so the host that runs the chat enforces them: its tool offer leaves them out,
   extension tools included, and its HUI tool bridge refuses them, with a second
   check in HUI's agent-tool handler. The prompt and `/skill:` list only the
   skills that are on, and `load_skill` loads them for a bot without `read` or
   `bash`. The bot asks for something that is off with `request_access`, a
   session question with Allow and Deny only the operator answers, which says
   when a routine or another bot started the turn. `POST`/`PATCH` take the lists,
   `GET /__hui/bots/:id/catalog` lists what can be turned off (powerful tools
   labelled) and a pending request; the panel's Tools tab (between Soul and
   Settings) and `hui bot tools` / `hui bot skills` / `hui bot add --deny-tools
   --deny-skills` use them. A bot on a worker (item 6) keeps its lists in its
   document there, which the worker's host enforces; the gateway reaches them
   through new host operations (`bot.access.read`, `bot.access.write`,
   `bot.offer`: the catalog and creation's check computed there, skills by their
   mirrored paths), a grant there comes back in a `bot.access` frame, and each
   connection reconciles that worker's bots; offline, 503 naming it. Its chat
   there isn't offered `terminal`, `browser` or `watcher`, which the gateway's
   bridge refuses for any remote session (one list, `GATEWAY_ONLY_TOOLS`), so the
   catalog leaves them out and a list can't name them. Proof:
   `server/bots/durable-access.test.ts` (real requests: offers, the
   bridge, prompts, `/skill:`, `load_skill`, requests allowed, denied, refused
   and one at a time, the port, documents from before the lists),
   `server/runtimes/question-box.test.ts`, `server/bots/service.test.ts`,
   `server/routes/bots.test.ts` (a real gateway: what is off leaves the
   provider's request, a granted tool is on the next one, a skill that is off
   is not in the prompt, the roster follows), `server/bots/bots.test.ts`,
   `src/lib/bots/tools.test.ts`, `src/views/bot-tools.test.ts`,
   `cli/*.test.ts`, for workers `server/worker/host.test.ts` (the host's list
   operations and offer), `server/bots/remote.test.ts`, `server/bots/service.test.ts`,
   `server/bots/durable-access.test.ts` (a host with `gatewayOnlyTools`: a
   bot's chat never offered them nor able to ask for them, an ordinary session
   keeping them), `server/workers.test.ts` (the bridge still refuses them) and
   `server/bot-workers.test.ts` (a real local worker: created with lists,
   its catalog with a mirrored skill and without the gateway's own tools, what is
   off gone from its requests, a request allowed here and its grant reaching the
   roster, a skill named by the gateway's path, lists naming the gateway's own
   tools refused, offline answers), and an isolated gateway driven in a browser
   (screens in the pull request).
9. **Bots behind Labs while they are a preview** (implemented 2026-10-07,
   superseded 2026-10-20 by item 18; the
   owner's request, SPEC.md, "Bots stay behind an opt-in Labs setting while they
   are a preview"): the stack lands on `main` with bots off until Settings →
   Labs → *Bots* (`settings.labs.bots`) turns them on. Off, they are dormant
   everywhere: every bot route, call route and bot chat's session route answers
   409 naming the setting, routines are skipped (kept, never failed), nothing
   starts a bot's turn and turning them off stops what they were doing; the UI
   shows nothing of them; nothing is deleted, and on again restores everything
   live. It is the one switch: item 3's Settings → Sessions → *Show the Bots
   tab* folds into it (a file where that was on keeps bots on). **Bots stay
   behind Labs until HUI-18 is done**: the flag (and this
   item's refusals) go only once the owner calls bots finished, in their own
   change. Proof: `src/lib/settings/settings.test.ts`, `server/bots/service.test.ts`,
   `server/routes/bots.test.ts` (a real gateway: every refusal while off, toggled
   live through `PUT /__hui/settings`, a routine skipped then run, a bot stream
   ended), `src/views/hui-owned-surfaces.test.ts`, `src/views/bots.test.ts`,
   `src/views/settings-automation.test.ts`, `src/lib/bots/bots.test.ts`,
   `src/lib/voice/live-call.test.ts`, `cli/*.test.ts`, and an isolated gateway driven
   in a browser (`e2e/bots-labs.browser.md`, removed with item 18; screens in
   the pull request).
10. **Schedules as a CLI, and bots that schedule their own routines**
    (implemented 2026-10-07; the owner's request, SPEC.md, "Schedules are a CLI,
    and bots schedule their own routines"): `hui schedule` (alias `schedules`)
    lists, shows, adds, edits, pauses, resumes, runs and removes every
    Automation task, attached to a session or a bot (`--session`/`--bot`, which
    also move a task on edit), and `hui bot routine` runs on its code. A bot's
    `routines` tool (the bot tools' extension, *Manage its own routines* in the
    Tools tab, on by default, not powerful) lists, adds, changes and removes its
    own chat's routines, behind the gateway's guards: its own chat only, 20
    active at most, once a minute at most, and no adding or changing in a turn
    another bot started (set_profile's origin check). Temporary tasks take
    `until` and/or `runs` and are deleted after either, across a restart too;
    a bot can remove its routine from that routine's own turn. Tasks record who
    made them (`createdBy`) and their limits as optional fields, shown in the
    Routines tab and on Automations (*made by @bot*, *until 18:00*, *3 runs
    left*). Bots off, every bot-facing part refuses and `hui schedule` prints
    the gateway's refusal; sessions' schedules work regardless. Proof:
    `server/automation.test.ts` (makers, limits, expiry by `until` and by runs,
    a skipped run given back, across a restart), `server/bots/routines.test.ts`
    (own tasks only, the cap, the minimum interval, names, the origin check,
    removal from a routine's own turn), `server/bots/durable-routines.test.ts`
    (the tool in the bot tools' extension, the catalog entry, turned off and
    refused by the bridge), `server/bots/schedules.test.ts` (a real gateway: a
    bot adds a temporary routine through a real turn, that routine's turn
    removes it, another bot's message can't add one, `hui schedule` with bots
    off), `server/bot-workers.test.ts` (the tool from a bot on a worker),
    `cli/schedules.test.ts`, `cli/*.test.ts`, `src/lib/bots/routines.test.ts`
    and an isolated gateway driven in a browser
    ([`e2e/bot-schedules.browser.md`](../e2e/bot-schedules.browser.md), screens
    in the pull request).
11. **Triggers** (implemented 2026-10-07, its sources replaced by listeners'
   on 2026-10-13, item 13; the owner's request, SPEC.md, "Triggers wake bots on
   GitHub, session and webhook events"): per-bot triggers beside its
   routines in `bot-triggers.json` (owner-only, atomic, like `bots.json`), the
   GitHub pollers' cursors in `bot-trigger-cursors.json`. Three sources: GitHub
   (one poller per repo through the gateway's `gh api --include`, conditional on
   ETags so quiet polls are free 304s, `X-Poll-Interval` and `Retry-After`
   honoured, a silent baseline and cursors saved before events go out; pull
   requests opened, pushed, merged and closed, checks failed or passed, reviews,
   comments and mentions of the operator, filtered by author, label, base, number
   and draft), sessions the bot started (finished, failed, waiting; one check,
   `sessionWatchable`), and webhooks (`POST /__hui/hooks/<token>`, tailnet and
   loopback only, a token shown once and stored hashed, a 64 KiB body, an optional
   equals/contains field filter). Deliveries are `[trigger: <name> · <summary>]
   <prompt>` with the event's details through the bot's message path (its remote
   session for a bot on a worker), recorded as runs; a cooldown coalesces events
   into one delivery, and a bot takes at most 12 deliveries an hour and has at
   most 20 triggers. Bots off: pollers stop, webhooks answer 409, session events
   are skipped; on again, a catch-up delivery per trigger. The bot's `triggers`
   tool (an ordinary Tools switch under Bots) lists, adds, changes and removes its
   own, never adding or changing in a turn another bot or a trigger started, and
   never a webhook. The Routines tab's Triggers section and `hui bot trigger
   list|add|remove|test`. Slack came next (item 12), read through search rather
   than Socket Mode. Proof: `server/bot-triggers*.test.ts` (a fake gh for the pollers,
   ETag/304 accounting, cursors across a restart, coalescing, the hourly cap,
   catch-up, the tool's origin checks, the webhook token, filter and size cap,
   bots off), `server/routes/bot-triggers.test.ts` (a real gateway: a webhook and
   a fake GitHub's pull request reaching the bot through the fixture provider,
   the bot's tool, the CLI, bots off), `server/bot-workers.test.ts` (a real local
   worker: a webhook's delivery runs on the worker, and the bot's tool there
   reaches the gateway), `server/bots/durable-access.test.ts`,
   `src/lib/bots/triggers.test.ts`, `src/views/bot-triggers.test.ts`,
   `cli/bot-triggers.test.ts` and an isolated gateway driven in a browser
   (`e2e/bot-triggers.browser.md` before item 13 rewrote it, screens in the pull
   request).
12. **Slack triggers** (implemented 2026-10-08, removed 2026-10-13, item 13; the
   owner's request, SPEC.md,
   "Slack triggers wake bots on review pings"): a Slack connection per gateway
   (Settings → Integrations → Slack and `hui slack connect|status|disconnect`: the
   User OAuth Token of an app the operator creates from HUI's manifest, user
   scopes only and read-only, verified with `auth.test`, stored like Jira's,
   never returned or logged) and a `slack` trigger source: mentions of the
   operator in channels and group DMs and direct messages to them, read through
   `search.messages` every minute by one poller with a saved cursor (a silent
   baseline, each message once, edits never, a 24-hour catch-up after bots were
   off or the machine slept, Retry-After and back-off, a revoked token parked
   until the operator connects again), filtered by PR links (a thread reply
   counts its parent's), people, channels, and whether bots or Slack Connect
   people may wake it. Deliveries carry who and where, the message and its
   thread parent, the permalink and each linked pull request read through the
   gateway's `gh` (description, files and diff, bounded), so a bot without a
   shell reviews from the delivery alone; the Triggers section has a Review
   requests preset, and only the operator adds or changes Slack triggers.
   Follow-up: mentions of a user group. Proof: `server/slack.test.ts`,
   `server/bot-triggers-slack.test.ts` and `server/bot-triggers-slack-prs.test.ts`
   (a fake Slack Web API, `e2e/slack-fixture.mjs`, and a fake clock: pagination,
   429, revoked tokens, catch-up after a restart and a sleep, dedupe, edits,
   threads, DMs, bots, Slack Connect, diff truncation), `server/bots/triggers.test.ts`
   (filters, delivery, the tool refusing Slack triggers),
   `server/slack-routes.test.ts` (a real gateway: connecting, a ping with a pull
   request reaching a bot whose gated tools refuse the turn, bots off and on, the
   CLI, the token in no route, diagnostic, log or model request), `cli/slack.test.ts`,
   `src/lib/slack.test.ts` and an isolated gateway driven in a browser
   (`e2e/slack-triggers.browser.md`, removed with it; screens in the pull
   request).
13. **Listeners, the only triggers** (implemented 2026-10-13; the owner's
   requests, SPEC.md, "Listeners report what HUI doesn't read itself" and
   "Listeners are the only triggers"): a trigger's listener, a program the
   operator runs, reports `{ events }` to the trigger's URL (`POST
   /__hui/hooks/<token>`, tailnet and loopback only, its token shown once and
   stored as a SHA-256); HUI wakes the bot once per event id (the last 500 kept
   in `bot-triggers.json` with the delivery they decide), never for an event
   older than the trigger, through a filter on a field, linked pull requests,
   and events marked as bots' or outsiders'; an empty report is a check-in, and
   the trigger shows the listener's last report, its problem or its silence. The
   GitHub, session, webhook and Slack sources went, with HUI's Slack connection,
   `hui slack` and the `triggers` tool's `add` and `update`; `hui doctor --fix`
   deletes what they left (`cli/doctor-triggers.ts`). Proof:
   `server/bots/triggers-listener.test.ts`, `server/bots/triggers.test.ts`,
   `server/routes/bot-triggers.test.ts` (a real gateway: reports, the URL's
   checks, the linked pull request read through a fake gh, the gated tools on a
   trigger's turn, bots off), `server/bot-workers.test.ts` (the same on a
   worker), `cli/doctor-triggers.test.ts`, `cli/bot-triggers.test.ts`,
   `src/lib/bots/triggers.test.ts`, `src/views/bot-triggers.test.ts` and an
   isolated gateway driven in a browser
   ([`e2e/bot-triggers.browser.md`](../e2e/bot-triggers.browser.md), screens in
   the pull request).
- **Compact trigger steering** (implemented and verified locally 2026-10-19):
  operator-selected `delivery: "steer"` sends event summaries, times and PR links into the active
  turn, without listener details or automatic GitHub reads. Idle bots start a
  turn; existing triggers keep full-context follow-ups. Cooldowns, caps,
  attribution and origin guards stay unchanged. The add form exposes the mode
  and templates preserve it. Proof: `server/bot-trigger-routes.test.ts` at the
  real gateway/runtime boundary, the trigger/template tests, and the isolated
  desktop/mobile journey in `e2e/bot-triggers.browser.md`.

14. **The panel as a profile** (implemented 2026-10-16; the owner's request,
   SPEC.md, "The bot panel is a profile you can resize and expand"): the panel
   opens on the bot's overview (profile, routines, triggers, activity, setup),
   whose rows open its Routines, Triggers, Tools & skills and Settings pages;
   its edge resizes it and the width is remembered; Expand fills the bot's view
   over a hidden, still-mounted chat. The Memory and Soul tabs and their client
   code went; `hui bot memory` and `hui bot soul` stay. Proof:
   `src/lib/bots/roster.test.ts`, `src/lib/bots/routines.test.ts`,
   `src/lib/bots/tools.test.ts`, `src/views/bots.test.ts` and an isolated
   gateway driven in a browser
   ([`e2e/bots.browser.md`](../e2e/bots.browser.md), screens in the pull
   request).
15. **Tagging bots by @handle** (implemented 2026-10-16; the owner's request,
   SPEC.md, "Agents and bots tag bots by @handle"): each bot reads like a skill,
   its description saying when to tag it and `tagging` who may (anyone, only
   when the operator's message names it, nobody), both in a Tagging section of
   its Settings page and `hui bot add|edit --description --tagging`, carried by
   export and import. While bots are on every Durable session lists the bots it
   may tag in its `bots` section and has `message_bot` (`hui-bot-tag`), a
   session on a worker asking the gateway for the list; a session's tag arrives
   as `[from agent: <title>]`, which no gated tool takes for the operator, and
   nothing comes back. The composer's `@` suggests bots before files. A bot's
   subagents don't tag and a session shares its hourly budget with its
   subagents. Proof: `server/bots/service.test.ts` (sessions' tags, the mention
   rule and HUI's own messages, budgets, rosters), `server/bots/bots.test.ts`,
   `server/bots/durable.test.ts` (the tool and section in a session,
   on and off), `server/bot-workers.test.ts` (a session on a worker),
   `server/bots/routines.test.ts`, the template tests, `cli/main.test.ts`,
   `cli/bots.test.ts`, `src/lib/bots/bots.test.ts`, `src/lib/local-paths.test.ts`,
   `src/views/bots.test.ts` and an isolated gateway driven in a browser
   ([`e2e/bot-tagging.browser.md`](../e2e/bot-tagging.browser.md), screens in
   the pull request).
16. **Bot exports as templates, reviewed for personal information** (implemented
   2026-10-16; the owner's request, SPEC.md, "Bot exports are templates, reviewed
   for personal information"): ⋯ → Export… cleans the bot (`bot-templates/cleanup.ts`),
   has Settings' utility model sort what is left into removed, asked, confirmed
   and kept as plain completions without tools (`bot-templates/review.ts`), keeps
   the review per bot (`bot-export.ts`) and zips what the operator's picks make
   of it (`buildExport`, shared with the dialog); version 2 of `bot.json` carries
   open points, needs, triggers and the files beside each skill, never memory,
   handle, paths or dates. Import fills `{{user}}`, closes SOUL.md with *Not agreed
   yet*, makes triggers disabled, writes skill files (on a worker behind
   `bot-skill-files`) and starts a first turn that is not the operator's
   (`from: template`). Proof: `server/bots/templates/cleanup.test.ts`,
   `server/bots/export.test.ts`, `server/bots/template-import.test.ts`,
   `server/bots/templates/formats.test.ts`, `server/bots/skills.test.ts`,
   `server/routes/bot-templates.test.ts` (a real gateway with the fixture
   provider as utility model: the review's requests carry no tools and none of
   the owner's text, the zip none of it, a changed bot is 409, and the import
   asks the new owner), `cli/bot-templates.test.ts`, `src/lib/bots/templates.test.ts`,
   `src/views/bot-import.test.ts` and an isolated gateway driven in a browser
   ([`e2e/bot-templates.browser.md`](../e2e/bot-templates.browser.md), screens in
   the pull request).

16. **Reply to the originating agent** (implemented and verified locally
   2026-10-16; SPEC.md, "Bots can notify the agent that handed them work"):
   `message_bot` accepts a reply-only `agent:<session id>` address attached by
   the gateway to session handoffs. Received-message receipts authorize later
   notifications without opening general cross-session sends. Bot policies,
   budgets, attributed inputs and the hop bound remain in force through agent
   replies. Proof: `server/bots/service.test.ts` (delivery, queues and denial
   cases), `server/bot-workers.test.ts` (real Durable tools across the worker
   connection in both directions), `server/bots/durable.test.ts`, and
   an isolated Browser-tool agent → bot → agent journey at desktop/mobile
   ([`e2e/bot-agent-replies.browser.md`](../e2e/bot-agent-replies.browser.md)).

17. **Explicit bot knowledge** (implemented 2026-10-18; SPEC.md,
   "Explicit bot knowledge"): Setup → Memory keeps manual facts, preferences
   and decisions with provenance, edit/delete/pin and revision conflicts,
   separate from OptChat. `facts.json` stays on the bot's execution host and
   each chat request and the call helper read current knowledge. No automatic
   extraction or additional model calls. Proof: `server/bots/facts.test.ts`,
   `server/routes/bots.test.ts`, `server/bot-workers.test.ts`,
   `server/bots/remote.test.ts`, `server/bots/call-helper.test.ts`,
   `src/lib/bot-facts.test.ts` and the isolated Browser journey
   [`e2e/bot-facts.browser.md`](../e2e/bot-facts.browser.md).

18. **Bots are always on** (implemented 2026-10-20; the owner's request,
   SPEC.md, "Bots are always on"): Settings → Labs → *Bots* is gone, and with
   it item 9's refusals. The Bots tab, bot chats, routines, triggers and calls
   are always there, and every session is offered `message_bot`. A saved
   `labs.bots` or `bots.showTab` is ignored and dropped at the next save. Proof:
   `src/lib/settings/settings.test.ts` and `server/hui-settings.test.ts` (their
   shared fixture), `server/bots/durable.test.ts`,
   `server/bots/durable-access.test.ts`, `server/bots/triggers.test.ts`,
   `src/controllers/bots-controller.test.ts`, `src/hui-app-bots.test.ts`,
   `src/views/hui-owned-surfaces.test.ts`, `cli/*.test.ts`. Browser proof
   (2026-10-20, an isolated gateway from this branch, desktop and 390×844): a
   fresh install shows the Agents | Bots switch, Labs lists only its two other
   flags, *New bot* creates a bot that greets in its chat, and a `PUT` with
   `labs.bots: false` and `bots.showTab: false` saves neither key and leaves
   `/__hui/bots` answering.

### HUI-19 — Agent widgets

Done 2026-10-06. Agents and bots show interactive HTML/SVG widgets inline in the
chat through the HUI `show_widget` tool, ported from OpenClaw's: the gateway
validates the fragment (256 KiB, no full documents, every inline classic and
module script parsed with line:column errors), the call itself is the only
record, and the chat renders it as a titled card in a two-frame opaque-origin
sandbox (`/__hui/widget-sandbox`, a strict CSP with no connections) on HUI's live
theme, with fitted height, full screen, error notices and click-only links.
`sendPrompt` is a follow-up. Proof: `server/runtimes/widget-code.test.ts`,
`server/agent-tools/widget-sandbox.test.ts`, `src/lib/widgets.test.ts`,
`src/components/widget-card.test.ts`, `src/views/chat/projection.test.ts`,
`server/runtimes/pi-sdk.test.ts` and `e2e/widgets.browser.md`.

### HUI-20 — Secret requests

Done 2026-10-06. Agents ask the operator for a secret (an API key, a token, a
password, a one-time code) with the HUI `secret_request` tool instead of the
chat. The request is a masked *Secret* card in the question dock that leaves
the session waiting; the gateway writes the answer to a private temporary file
(`0600` in its own `0700` directory, deleted after 10 minutes or at gateway
stop, a crashed gateway's at the next start) and the agent receives only its
path, so the value never reaches the transcript, the model, PI's or Durable's
stores or diagnostics. Cancel, Stop and a 15-minute expiry end it. The bridge
now passes a tool call's abort to the gateway handler for PI children and
Durable alike, and PI children reach it over `node:http`, whose replies may
take longer than fetch's five minutes. Proof: `server/agent-tools/secret-requests.test.ts`,
`server/agent-tools/bridge.test.ts`, `server/live-sessions.test.ts`,
`server/runtimes/pi-sdk.test.ts`, `server/runtimes/durable.test.ts` and
`e2e/secret-requests.browser.md`.

Follow-up 2026-10-06: worker sessions get secret requests too. The card stays on
the gateway; its answer goes back over the worker connection (`secret-request`)
and the worker host writes the file there, with the same naming, lifetime and
cleanup. Requests across the connection can now be cancelled (`cancel`), so a
Stop on the worker closes the card. Proof: `server/worker/protocol.test.ts`,
`server/worker/host.test.ts`, `server/workers.test.ts` and the worker section of
`e2e/secret-requests.browser.md`.

### HUI-21 — Work pane

**Status:** implemented on `feat/work-pane`; validation recorded in
[`e2e/work-pane.browser.md`](../e2e/work-pane.browser.md).

A right-hand Work pane after AgentsInTheCloud's: per conversation, following the
focused chat pane, a tab strip of Work views with a **+** launcher menu, an empty
state listing launchers and shortcuts, a collapsed rail, a resizable edge and a
full-screen destination below 1100px reached from the panel selector. Terminal
and browser views move out of the chat multiplexer into it (saved layouts migrate
on load); chat splits and tabs are unchanged. `src/lib/work-pane.ts` is the Work
view contract that the Files (F) and VS Code (V) views register against. Proof:
`src/lib/work-pane.test.ts` (state transitions, tolerant loading, retention,
migration), `src/lib/shortcut-binding.test.ts`, `src/views/panel-selector.test.ts`,
`src/lib/session/multiplexer.test.ts` (the old format stays readable) and the
Browser-tool journey.

## Recommended implementation order

`HUI-01 → HUI-02 → HUI-03 → HUI-04 → HUI-05 → HUI-06`, then run HUI-07,
HUI-08, HUI-09 and HUI-10 independently before HUI-11.

The first implementation task should be **HUI-01**. The current session code is
already substantial, but its contract must be frozen before visual work starts
depending on undocumented process behaviour.


The 2026-09-25 sidebar follow-up adds independent, keyboard-accessible disclosure
buttons for parent sessions. Folding hides all descendants without changing the
open chat, preserves nested fold choices, and reveals filtered matches.
The 2026-09-29 follow-up makes trees follow the selection: only the selected
session and its ancestors show their subagents, and choosing another session
folds the previous tree and discards manual toggles.
Verified desktop/mobile behavior and checks are recorded in
[`e2e/subagent-tree-collapse.browser.md`](../e2e/subagent-tree-collapse.browser.md).

### HUI-14 — npm-distributed Electron desktop app

**Status:** implemented; native macOS verification pending.

- Electron reuses the production UI, managed CLI gateway lifecycle and active
  release selection. Closing/quitting the UI does not interrupt shared jobs.
- Global macOS installation creates a named/icon-bearing, ad-hoc-signed
  `~/Applications/HUI.app`; `hui install-app` repairs script-blocked registration.
- Installer fixtures cover ownership, replacement, rollback and install gating;
  shell tests cover gateway startup, single-instance focus, renderer isolation
  and navigation/clipboard policy.
- The existing installed-package lifecycle suite includes the desktop assets
  in release/update fixtures. Browser proof and native-platform limitations:
  [desktop package proof](../e2e/desktop-package.browser.md).

### HUI-17 — Remote workers

**Status:** implemented; real-provider proof on a long-lived remote pending.

- A worker is a name plus a connect command (`ssh`, `docker exec -i`,
  `kubectl exec -i`, …). HUI installs Node if needed, its own worker release
  with the PI SDK and Pi Durable (Node 22.19+), starts a durable per-user host
  and mirrors the user's PI resources and HUI settings; credentials stay on the
  gateway, are brokered per request and cached only in host memory until they
  expire.
- Worker sessions run on the local runtime choice (Durable by default) inside
  the host, driven through the generic runtime contract; the PI-specific relay
  is gone. Work continues while the gateway is away and catches up on
  reconnect; a host restart resumes Durable runs.
- New Session runs on a worker; subagents follow their parent. Sessions keep
  running while the gateway is away, reattach with their pending questions,
  and reconnect by themselves after a dropped connection.
- Proof: `server/workers.test.ts` (real host, SDK worker and deterministic
  provider behind a separate home: brokered API key and OAuth refresh, no
  secret on the remote, reattach, question replay, close/delete; Durable on the worker with HUI settings and providers, HUI tool calls,
  abort, a gateway lost mid-tool, an offline follow-up and a host restart),
  `server/worker/release.test.ts` (the release installs every imported
  package), plus manual runs against an Ubuntu 24.04 arm64 container over
  `docker exec -i` and over SSH: Node download, release install, package
  dependency install, durable runs across a killed transport, host upgrade, and
  the Settings → Workers, Run on and reattach journeys in the browser.
- Not yet remote: terminals, the managed browser, worktrees/branch checkout,
  multi-account quota rotation and usage totals.
