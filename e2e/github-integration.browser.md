# GitHub integration browser verification

Verified on 2026-09-25 with the OpenClaw Browser tool against the real HUI
gateway (Vite, port 5198) and an owned headless Brave. No operator GitHub login
was read or changed.

## Reproduce

1. Create a fresh `/tmp/hui-github-e2e-*` root with `workspace`, `pi-agent`,
   `pi-sessions`, `xdg/hui` and `gh`.
2. Start Vite with `XDG_CONFIG_HOME`, `PI_CODING_AGENT_DIR` and
   `PI_CODING_AGENT_SESSION_DIR` under the root, plus
   `HUI_GITHUB_CLI=$PWD/e2e/fixtures/github-cli-fixture.mjs`, `HUI_FAKE_GH_DIR=<root>/gh`
   and `HUI_FAKE_GH_CODE=HUIE-2E42`. Set `NO_PROXY=127.0.0.1,localhost` when an
   HTTP proxy is configured.
3. Open `/settings/integrations` at 1440×900, then 390×844. Approve a pending
   login with `touch <root>/gh/approve` (the fixture then writes `account`).

## Observed

- **Settings → Integrations** listed GitHub after Jira with status *Not
  connected* and a *Connect GitHub* button.
- Clicking *Connect GitHub* showed *Waiting for approval…*, the one-time code
  `HUIE-2E42`, its expiry, *Copy code* and *Open github.com/login/device*
  (`target="_blank"`, `https://github.com/login/device`).
- After approval the section turned *Connected* without a reload and showed
  "Connected as hui-e2e." and the account row (`github.com · gh 9.9.9 · gist,
  read:org, repo`).
- At 390×844, *Copy code* changed to *Copied*; the page had no horizontal
  overflow (`scrollWidth` 390). *Cancel* returned to *Not connected* with the
  Connect button and no code.
- With `HUI_GITHUB_CLI` pointing at a missing path the section showed *GitHub
  CLI required*, "GitHub CLI not found", *Install gh* (cli.github.com) and
  *Check again*, and no Connect button. `POST /__hui/github/login` returned 409
  with "GitHub CLI (gh) is required…".
- **Real gh 2.101.0** with an empty isolated `GH_CONFIG_DIR`: the login route
  returned a real device code for `https://github.com/login/device`; `DELETE`
  stopped the `gh auth login` process and returned to idle. The code was not
  approved, so no account was created.

## Proof gap

GitHub approval of a real device code was not exercised end to end; the fake
CLI stands in for `gh` finishing successfully. The approved path's status
probe is the same `gh auth status --json hosts` call verified against real gh.
