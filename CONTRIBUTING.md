# Contributing to HUI

HUI is open source, but the public npm registry is not used: development and
releases are distributed as npm archives (`.tgz`). See the installation
section in [`README.md`](README.md) for the user-facing commands.

## Requirements

- Node.js **22.18 or newer** and npm.
- Git.
- GitHub CLI (`gh`) authenticated when opening or maintaining pull requests.

```sh
git clone https://github.com/DaniFdz/hui.git ~/Projects/HUI
cd ~/Projects/HUI
npm ci
```

## Pull requests are mandatory

Every change reaches `main` through a pull request, including documentation,
version bumps and release commits. Do not commit to or push `main` directly.

1. Branch from an up-to-date `origin/main`; branch names are free-form.
2. Start every commit message and the PR title with a Conventional Commits type:
   `feat:`, `fix:`, `docs:`, `refactor:`, `test:` or `chore:`.
3. Keep each PR to one coherent change and run the checks below.
4. Push the branch and open the PR with `gh pr create`. The description follows
   the template: what changed, why, the exact checks that ran, screenshots for
   visible UI changes (desktop and mobile when relevant) and any proof gap.
5. The owner reviews every PR. Address feedback with new commits on the same
   branch; merge only after the owner explicitly approves and checks are green.
6. Leave no review comment unattended: resolve the thread once its suggested
   action is pushed; otherwise reply in the thread and leave it open.

Merging a version-bump PR publishes a release after checks pass; ordinary PRs do
not. See [Releasing a version](#releasing-a-version).

## Development loop

Work on a feature branch and use the Vite loop while changing code:

```sh
git switch main
git pull --ff-only
git switch -c feat/my-change
npm run dev       # browser at the printed Vite URL
npm run desktop   # optional standalone Chromium window
```

When dependencies change, run `npm install` to update `package-lock.json` and
commit it together with `package.json`; the Lockfile workflow runs `npm ci` on
every push and pull request and fails if they drift. After pulling dependency
changes, rerun `npm ci`. Keep development and installed
production gateways separate; they must not share live PI transcripts.

Before handoff, run the checks appropriate to the change:

```sh
npm test
npm run typecheck
npm run build
npm run test:package
```

The Test workflow runs `npm run typecheck` and `npm test` on every pull request
and push to `main`, on Node 24, the only version `engines` allows. `npm test` runs the suite with Vitest and fails,
naming it, a test or hook that runs longer than five minutes instead of waiting
for it. The workflow reports every run to Datadog Test Optimization, using the
repository's `DD_API_KEY` secret.

User-visible changes also need a real Browser-tool E2E check. Documentation-only
changes need at least `git diff --check` and verification that commands and links
still match the source.

### Doctor checks for breaking changes

`hui doctor` is how an upgrade changes state earlier versions left behind. A
change that leaves persisted state behind (a format, a location, a runtime
switch) adds a check in `cli/doctor-<name>.ts` and lists it in `DOCTOR_CHECKS`
(`cli/doctor.ts`):

- `inspect()` only reads. It reports each affected item as `issue`, which
  `--fix` changes, or `blocked`, with what the operator must do first.
- `fix()` changes the `issue` items. It runs only with the gateway stopped,
  under the lifecycle lock. Keep it idempotent, back up what it rewrites, and
  never delete user data.
- Test both against isolated state (`cli/doctor.test.ts`), and extend
  `e2e/package.test.ts` when the installed CLI should prove it.

## Visual verification and PR evidence

Follow the repository-owned
[HUI visual verification skill](.agents/skills/hui-visual-verification/SKILL.md).
It uses existing PI fixtures and browser tools, not a Cursor-specific runtime.
From an isolated feature checkout:

```sh
node e2e/visual-verification.mjs launch --branch "$(git branch --show-current)"
# In another terminal, use the receipt path printed by launch:
node e2e/visual-verification.mjs doctor --receipt /path/to/receipt.json
# Drive the printed URL with the Browser tool, then:
node e2e/visual-verification.mjs cleanup --receipt /path/to/receipt.json
```

For UI changes, upload fresh inspected desktop/mobile screenshots to the **PR
body**, using the PR template, and share them in the conversation. Never commit
screenshots. The [feature map](.agents/skills/hui-visual-verification/references/features.md)
routes to the existing targeted journeys; a screenshot alone does not prove the
interaction or backend. If GitHub image attachment is unavailable, keep the PR
draft and state the delivery gap. With GitHub CLI 2.99.0+, combine `--body-file`
with repeated `--attach` flags to upload images without a browser login; see the
skill's [evidence handoff](.agents/skills/hui-visual-verification/references/pr-evidence.md).

Run the launcher's focused lifecycle tests when changing it:

```sh
node --test e2e/visual-verification.test.mjs
```

## Nix development and packaging

The Linux flake pins nixpkgs in `flake.lock` and the npm dependency cache in
`nix/package.nix`. Start a source-development environment with:

```sh
nix develop
npm ci
npm run dev
```

The shell supplies Node.js 24/npm, Git, search tools and native build support.
It does not install npm packages, start services, or modify your shell settings.
The default package is web-only; `hui-desktop` adds nixpkgs Electron and a desktop
entry without using npm's downloader. `nixosModules.default` provides service and
GUI-installation options. See the [user guide](docs/guide.md#nix-and-nixos) for the
configuration examples.

```sh
nix build
nix flake check --print-build-logs
nix run . -- --version
```

The check exercises the built CLI, immutable-install update guard, native PTY,
PI SDK and CLI entrypoints, and gateway start/status/HTTP/stop using temporary
HUI/PI state. It also checks configured bindings, module evaluation (including
desktop-only installs), and the installed Electron launcher rendering HUI under
Xvfb through CDP. Only that sandboxed test passes `--no-sandbox`; the installed
launcher does not. No model provider is contacted. This is native-rendering
smoke coverage, not the full Browser-tool conversation journey. CI runs these checks on x86-64 Linux; ARM64 is an available build target
but requires an ARM64 builder for runtime verification.

After changing `package-lock.json`, update `npmDepsHash` in `nix/package.nix`:
set it temporarily to `lib.fakeHash`, run `nix build`, then replace it with the
reported `got: sha256-...` value and rerun the build/checks. The cache uses fetcher
version 2 because PI's nested shrinkwrap also requires URL metadata offline.
Every resolved registry tarball needs an integrity entry; upstream PI's lockfile
can omit these. Recover any missing integrity from npm metadata and verify the
downloaded archive against it, without changing dependency versions.

Use `nix flake update nixpkgs` for an intentional nixpkgs refresh and commit the
updated lock. Keep the explicit source file set in `nix/package.nix` aligned with
new build inputs; never add credentials, personal state or generated output.
Do not change the host's NixOS configuration merely to work on this flake.

## Testing the installed package

### Built-in good-practices skills

HUI bundles [create-verification-skill](skills/create-verification-skill/SKILL.md),
an agent-neutral adaptation of pstack's generator. It is available by default in
HUI-owned sessions, tagged **good practices**, and can be disabled in Skills (or
Settings → Skills) with the normal HUI-only toggle. Opting out does not change PI
configuration. Availability is not automatic execution: ask the agent to create
a verification skill for the current project when needed. Existing same-name PI
skills take precedence over the bundled default.

The generator inspects a project and produces its own verification instructions,
feature map and any needed helpers. It is separate from HUI's repository-local
`hui-visual-verification`, which contributors use to verify this application.
The source, compatibility notes and MIT attribution live together under
`skills/create-verification-skill/` and are copied into the installed archive.

HUI also bundles [git-selective-staging](skills/git-selective-staging/SKILL.md)
with the same tag and toggle. It tells an agent how to commit only its own hunks
when a shared or reused checkout already holds other uncommitted work, including
another session's edits in the same file.
When changing bundled resources or their default/opt-out behavior, run focused
runtime tests, the package proof and the Browser Skills toggle journey.

### Package smoke test

`npm run test:package` exercises a packed archive with temporary installation and
HUI/PI state. For a manual smoke test:

```sh
npm pack
npm install --global --prefix ~/.local ./hui-*.tgz
export PATH="$HOME/.local/bin:$PATH"
hui gateway start
hui gateway status
hui ui
```

The local archive is for development only. It does not become available to
`hui update` on another machine until it is published as a GitHub Release.

## Releasing a version

Release versions use semantic versioning and are cut only when the owner asks.
The version bump goes through a PR; the package version and tag must match:

```sh
git switch main
git pull --ff-only
git switch -c release/v0.1.2
npm version 0.1.2 --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: release v0.1.2"
git push -u origin release/v0.1.2
gh pr create --fill
```

The Release workflow checks every PR targeting `main`. If `package.json` changes
version relative to the PR base, it:

1. requires an increasing stable version (`X.Y.Z`) matching both lockfile versions
   and rejects tags already used on another commit;
2. generates `release-changelog.md` from all non-merge commits since the highest
   reachable stable version tag (not merely the commits in the version PR);
3. runs typecheck, the full test suite and installed-package proof, alongside the
   reusable Nix workflow (web and configured packages, NixOS module evaluation,
   Electron rendering under Xvfb, and the flake application); and
4. uploads a `<tag>-package` Actions artifact with the `.tgz`, SHA-256 sidecar and
   changelog. The changelog is also available in the planning job summary and a
   separate artifact, even if packaging fails.

When the release adds user-visible features, it also gets a demo video of them,
filmed with `e2e/demo/record.ts` as the
[release video skill](.agents/skills/hui-release-video/SKILL.md) describes: new
clips land in their own PR first, and each feature's clip goes into the
version-bump PR's description and, once published, the GitHub Release notes. Releases with only
fixes or maintenance say so instead.

Review the changelog and download the candidate package from the PR's Actions
run before approving. Commit subjects are listed chronologically with commit
links, plus a full comparison link. Merge commits are omitted to avoid duplicate
entries; the comparison includes the complete diff. Without a prior stable tag,
the changelog includes all history. Prerelease and unrelated tags are ignored.
The changelog is generated, not committed back into the branch.

After the owner approves and merges the version-bump PR, the workflow repeats
validation and packaging on the actual `main` commit, creates its matching tag,
and publishes the public GitHub Release with the changelog as release notes and
an attached Markdown file. **Merging a version-bump PR authorizes publication**;
there is no separate manual tagging step. Ordinary PRs do not publish anything.
Only the publish job has repository write permission; PR jobs cannot publish.
Publication requires both npm packaging and Nix validation to succeed. The Nix
checks also run independently on ordinary PRs; release validation covers both
version-bump merges and manual recovery tags on x86-64 Linux.
Existing releases are left unchanged on retries. If publication fails, rerun the
failed workflow in Actions after fixing the cause.

The manual `vX.Y.Z` tag trigger remains available for explicitly requested recovery
releases. It requires the tag to match `package.json` and runs the same checks.
No new token or PAT is needed: publication uses the workflow's `GITHUB_TOKEN`.

### Nightly builds

The Nightly workflow runs on every push to `main`. It runs typecheck, the full
test suite and the installed-package proof, and runs that proof again on macOS,
where the installation, desktop and update paths differ. It stamps the package with
`scripts/nightly-version.mjs` (a prerelease of the next patch, such as
`0.1.3-nightly.20261004131149.gb0f30d5`) and replaces the rolling `nightly`
GitHub prerelease with that archive and its checksum. A newer push cancels an
older run. GitHub never reports a prerelease as the latest release, so stable
`hui update`, `/update` and the release changelog are unaffected. Installations
opt in with `hui update --nightly`.

Once the release exists, another machine can download its archive and checksum
from the public GitHub Release, verify them, and install the archive. Existing
installations can use `hui update --check`, `hui update`, or `/update` in the chat.

Do not include credentials in commits or release notes. Keep unrelated changes
out of the release commit, and follow the root [`AGENTS.md`](AGENTS.md) rules for
validation, screenshots and the pull request for each completed iteration.
