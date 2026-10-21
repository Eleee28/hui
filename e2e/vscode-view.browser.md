# VS Code view journey

The Work pane's VS Code view (`<hui-vscode-view>`, `src/views/work/vscode.ts`)
in the real app, opened from a conversation's Work pane, with each provider:
the openvscode-server HUI installs (Linux), VS Code desktop through
`code serve-web`, and Settings switching between them. Keep screenshots outside Git.

## Setup

1. Real programs, never installed into a profile or the system:
   - openvscode-server: Gitpod's release tarball for this machine
     (`openvscode-server-v1.109.5-linux-x64.tar.gz`, the asset whose SHA-256 is
     pinned in `server/vscode/install.ts`), served from a local mirror: a small
     HTTP server answering `/releases/openvscode-server-v1.109.5/<asset>` from a
     directory holding it. A throttle (about 40 MB/s) keeps the progress visible.
   - VS Code: `NIXPKGS_ALLOW_UNFREE=1 NIX_CONFIG='experimental-features = nix-command flakes' nix build --impure nixpkgs#vscode --no-link --print-out-paths`
     (1.137.0 at the time of writing); its `bin/code` goes first on `PATH` only
     for the run that proves serve-web.
   - On NixOS both generic builds (the release's `node` and the VS Code server
     serve-web downloads) need an FHS environment: build one with
     `nix build --impure --expr '(builtins.getFlake "nixpkgs").legacyPackages.x86_64-linux.buildFHSEnv { name = "hui-fhs"; targetPkgs = p: [ p.stdenv.cc.cc.lib p.glibc p.zlib p.openssl p.krb5 p.libsecret ]; runScript = ""; }'`
     and run the launcher inside it (`<fhs>/bin/hui-fhs bash -c '…'`), so the
     gateway's children inherit it. Elsewhere run the launcher directly.
2. `npm ci`, then, without an ambient HTTP proxy for loopback and with
   `HUI_OPENVSCODE_SERVER_MIRROR=http://127.0.0.1:<port>/releases` (the launcher
   passes it to the gateway), `node e2e/visual-verification.mjs launch --branch "$(git branch --show-current)"`
   and `doctor` with the printed receipt.
3. Make the receipt's `workspace` a small Git repository (a README,
   `src/greet.ts`, `package.json`, one commit) and create a worktree conversation
   there (`POST /__hui/sessions` with `worktree: true` is setup, not proof).
4. Open `<browserUrl>/sessions/<id>` in an owned tab at 1440×900 (390×844 for the
   narrow layout).

## Journey

1. **Always there, nothing running.** With no VS Code anywhere, the Work pane's
   empty state and **+** menu list **VS Code** (Ctrl+Alt+Shift+C / ⌥⇧⌘C) with no
   reason under it. No VS Code process runs, and none starts until it is opened.
2. **Install card (Linux, no VS Code).** The shortcut opens the view on *Choose
   how to run VS Code*: **Install VS Code server** (openvscode-server 1.109.5,
   MIT, about 73 MB, with a link to its license) and **Set a path** (Settings →
   Tools → VS Code). **Install VS Code server (≈73 MB)** shows *Downloading… n MB
   of 73 MB* with **Cancel**, then *Checking the download…*, *Unpacking…*, and the
   view opens by itself: the workbench on the conversation's worktree (Explorer
   lists `src`, `fixture.txt`, `package.json`, `README.md`; the status bar shows its
   branch). The mirror logged one GET of the asset; the install directory holds
   only `openvscode-server-v1.109.5-linux-x64`. Neither the page nor the frame can
   read a cookie (`document.cookie` is empty in both).
3. **Settings.** Settings → Tools → VS Code shows *OpenVSCode Server 1.109.5 ·
   installed by HUI* with its path, *The only VS Code found here*, the installed
   server with **Remove**, the custom path, the running server with **Stop** and
   the data directory. **Remove** opens a confirmation listing *Deletes the
   server* and, while it runs, *Stops VS Code*; **Remove server** stops it and
   the row returns to *Not installed* with **Install (≈73 MB)**.
4. **Consent card (VS Code desktop).** Relaunch with VS Code's `bin/code` first on
   `PATH`. **+** → **VS Code** shows **Use your VS Code** (*Visual Studio Code
   1.137.0 is installed here…*, links to the VS Code Server License Terms and the
   Privacy Statement, **Accept and open**) above the install and path options.
   No `code serve-web` process exists yet. **Accept and open** records the
   acceptance and shows *Preparing VS Code — Downloading the VS Code server from
   Microsoft: n% of 223 MB (first start only)*, then Microsoft's workbench on the
   worktree. Its secret-storage cookie reaches only the frame
   (`document.cookie` is empty in the page).
5. **Switch.** In Settings, **Install (≈73 MB)** adds HUI's server; the picker
   offers *Automatic*, *Visual Studio Code 1.137.0 · your VS Code* and
   *OpenVSCode Server 1.109.5 · installed by HUI*, and the license row shows
   *Accepted <date>* with **Revoke**. Choosing openvscode-server stops serve-web
   (the pill reads **Ready**); the conversation's view reopens on
   openvscode-server.
6. **Narrow.** At 390×844 the panel selector's *VS Code · Work* shows the view
   full width with the folder truncated from the start and its three actions.
   Settings stacks each row's control under its text. **Revoke** and **Remove**
   leave nothing that can run: the view shows the card with all three options,
   which fits the width and scrolls on its own.
7. **Offline.** With no route to update.code.visualstudio.com, serve-web's first
   start fails after 60 seconds without a byte with *VS Code could not download
   its web server from Microsoft…* and **Retry** (covered by
   `server/vscode/vscode.test.ts`; not repeated in the browser).

## Automated coverage

`server/vscode/vscode.test.ts` (provider detection per platform, serve-web help and
version parsing, the provider order, consent gating: no spawn and no
`--accept-server-license-terms` before consent, the flag with it; serve-web's
download progress, stall and cancel; lazy start, idle stop, crash, process-group
stop, stale-server reaping, tickets and cookie secrets),
`server/vscode/install.test.ts` (architecture mapping, a fake release host with a
redirect, checksum and size mismatches rejected, a cut-off download cleaned up,
staging then atomic rename, a server that does not run left uninstalled,
cancel, the gateway's HTTP proxy honoured), `server/vscode/proxy.test.ts` (path
and header rewriting, cookie scoping including the WebSocket's 101, the
workbench patch for both providers, cookie and WebSocket guards against fake
servers) and `server/routes/vscode.test.ts` (the routes through HUI's middleware,
the license actions, a legacy settings file).
