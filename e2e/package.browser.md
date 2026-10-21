# Installed package — production gateway proof

Date: 2026-09-24. Linux, Node 24, HUI 0.1.0, PI SDK 0.87.1.

## Reproduce

1. `npm ci && npm run build`, then `npm run e2e:package`.
   The launcher packs the release and installs it into a temporary npm prefix.
   It starts the installed CLI on port 43129 (override `HUI_E2E_PORT`) with a
   local deterministic provider and isolated XDG config/data and PI directories.
   No personal credentials, settings, workspaces or transcripts are used.
2. Use the Browser tool to open `http://localhost:43129/`, labeled `hui-package`.
   At 1440×1000, open Settings → Tools before creating a session: verify 14
   shipped tools, SDK version, configured sources and the prompt disclosure.
3. Exit Settings. Select the temporary workspace printed by the launcher and
   submit `E2E_RICH`. Wait for Idle / Tool complete. Expand the activity and
   `Read fixture.txt`; its output must be `Production package browser fixture`.
4. Run the printed installed CLI with the fixture's `XDG_CONFIG_HOME`,
   `XDG_DATA_HOME` and `PI_CODING_AGENT_DIR`, followed by `gateway restart --json`.
   Verify the PID changes. Reload the session route in Browser and verify the
   same prompt, tool result and response return; no second session is created.
5. At 390×844, repeat transcript/tool disclosure and open navigation → Settings
   → Tools. Select the live session and inspect its tool catalog. Check that
   document width equals viewport width; capture and inspect desktop/mobile.
6. Inspect Browser errors. SIGINT/Ctrl+C to the launcher stops only the fixture
   gateway/provider; its temporary files remain available for diagnostics.

## Automated package boundary

`npm run test:package` builds and tests the actual packed archive, not a Vite
proxy or fake gateway. It verifies:

- Only compiled runtime/web/themes and the lockfile ship; no personal media,
  source tests, Vite runtime dependency or global `pi` requirement.
- Port collision, idempotent start, status/UI URL, Host denial, x-hui guard,
  built themes and deep-link static serving.
- A real SDK read call, persisted transcript after restart, busy stop/restart/
  update refusal, and explicit forced restart during a held streaming turn.
- SHA-256 mismatch leaves the current process untouched; valid update changes
  version; activation failure restores the old process/selection and registry.
- Explicit rollback works even if the selected release's CLI cannot import.
  Updating or rolling back a stopped gateway does not start it.
- After the last update only the pointer's current and previous releases stay
  on disk; older releases and the failed activation's stage are gone.
- CLI/state tests separately reject arbitrary control endpoints, PID-only
  signals, invalid commands and release-pointer path traversal.

## Observed and limits

Final checks: `npm test` (440 passing tests), `npm run typecheck`,
`npm run test:package` (includes production build and the installed-package
integration), `npm audit --omit=dev` (zero reported vulnerabilities), and
`git diff --check`. The packed release contains 245 files and no source tests or
personal media. Its generated dependency graph is included as shrinkwrap.

The installed production UI loads without Vite, creates a real SDK session,
renders its tool output and resumes after CLI restart on desktop and mobile.
The live model response comes from the local fixture, not a paid remote API.
Global tools work before any session exists. No application runtime errors were
reported in the observed Browser journey. Browser control intermittently lost
its shared profile/tab connection; fresh status/tabs observations recovered it.

This does not certify every provider/extension, a native mobile browser, remote
Tailscale connectivity, macOS/Windows process lifecycle, or opening a desktop
browser through `hui ui`. The archive is not publicly published and no automatic
release channel, login layer or boot service is installed. Package trust is
required; disabled npm scripts and a digest check are not a sandbox/signature.
