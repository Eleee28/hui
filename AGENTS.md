# HUI Repository Guide

Read this file and the nearest scoped `AGENTS.md` before changing a subtree.
Keep root rules limited to repository-wide constraints; put implementation
details in the owning directory guide.

## Start

- Inspect `git status --short` before editing. This is a shared checkout: preserve
  unrelated and in-progress changes, never stash/reset/clean them, and coordinate
  overlapping edits with the owning agent.
- Read `SPEC.md`, `docs/api.md`, and the relevant roadmap item before changing a
  product contract. Inspect the current implementation before adding an abstraction.
- [docs/map.md](docs/map.md) maps areas to their owning modules. Every source
  module starts with a header comment saying what it owns; keep it true when you
  change the module, write one for each new module, and name new source
  directories in the map (`scripts/module-headers.test.mjs` checks both exist).
- Use npm and the checked-in scripts. Do not edit `dist/`, `node_modules/`, or
  generated output by hand.

## Architecture

- HUI is a Lit browser application (`src/`) backed by a standalone Node gateway
  (`server/`); Vite is for development and web builds. `cli/` owns installed
  gateway lifecycle and release selection. PI owns agent configuration, skills,
  context files, models and credentials. New sessions run on Pi Durable: one
  harness in the gateway owns their conversations, runs, queues and crash
  recovery in HUI's store (`server/runtimes/durable*.ts`). HUI owns
  presentation, its session registry, default prompt and HUI tools. Sessions
  created before Durable keep running on PI's SDK worker, which owns their JSONL
  transcripts, until `hui doctor --fix` moves them; retain that worker and its
  explicit CLI fallback.
- Keep the browser free of filesystem and child-process access. All PI and local
  state access crosses typed `/__hui/` routes owned by `server/`.
- The browser consumes `/__hui/` only. No code is shared between `src/` and
  `server/`, `cli/` or `desktop/`. `scripts/boundaries.test.mjs` enforces this
  and the other dependency rules in `docs/map.md`, with no exceptions. The
  server publishes its payloads as JSON Schema (`docs/api.schema.json`,
  `GET /__hui/api-schema`), and the browser's payload types are generated from
  it with `npm run api:schema`.
- Runtime integrations implement the generic contract in `server/runtimes/`.
  Do not leak PI-specific protocol details into views.
- The agreed product currently uses full access. Do not introduce Agents,
  Approval, or Approvals surfaces without a new product decision.
- Keep APIs narrow, state ownership explicit, and TypeScript strict. Prefer small
  pure helpers and tests at the boundary that owns behavior.

## Validation

- Focused tests: `npm test -- <test-file>`; full unit/integration suite: `npm test`.
- Type safety: `npm run typecheck`. Production bundle: `npm run build`.
- Package/lifecycle changes: `npm run test:package` installs and exercises a real
  archive using temporary prefixes and isolated HUI/PI state.
- For UI verification and PR screenshots, follow
  [hui-visual-verification](.agents/skills/hui-visual-verification/SKILL.md).
  The repository-owned skill is the shared procedure, independent of editor.
- The shipped [create-verification-skill](skills/create-verification-skill/SKILL.md)
  generates verifiers for other projects. Keep its portable source and license
  intact; it does not replace HUI's own visual verification procedure.
- User-visible changes require a real Browser-tool E2E check through the running
  app, in addition to focused automated tests. Exercise the UI rather than only
  calling its HTTP endpoints, inspect the resulting screen, and report any proof
  gap explicitly.
- Never weaken assertions, add sleeps, or hide failures to make a check pass.
  Synchronize on observable state and fix defects at their owning boundary.

## Change Discipline

- Keep behavior changes, tests, and contract documentation aligned in one task.
- Do not add dependencies, alter persisted formats, or delete PI/HUI user data
  without explicit approval. Tests use temporary directories and isolated processes.
- A change that leaves existing persisted state behind (a format, location or
  runtime switch) ships with a `hui doctor` check that reports it and fixes it
  under `--fix`; see CONTRIBUTING.md.
- Commit every `package.json` dependency change together with the updated
  `package-lock.json`; `npm ci` must succeed on a clean checkout.
- Before handoff, review the diff, run the narrowest relevant checks plus required
  broader checks, and state exactly what ran. Never claim an unrun check passed.
- Finish each iteration by committing the validated HUI changes, pushing the
  branch and opening or updating its pull request. For visible UI changes, include
  fresh rendered screenshots, with desktop and mobile views when relevant, in both
  the PR description and the conversation; they document the change for review and
  later tracing. Never commit screenshots to a working branch or `main`. If
  GitHub attachment delivery fails, keep the PR draft and report the proof gap
  instead of storing the images in the source tree. Report chat delivery gaps too.
  Keep unrelated changes and personal workspace files out of commits.
- This repository is public. Keep Datadog-internal material out of commits, PRs,
  issues and comments: internal tools, infrastructure, hostnames, repositories,
  services, people, channels and workflows that only work inside Datadog. They
  belong in local skills or extensions. Features built on Datadog's public product
  and APIs, such as the Datadog embeds, are fine.

## Pull requests

- All changes reach `main` through a pull request. Never commit to or push `main`
  directly, including documentation, version bumps and release commits.
- Branch from an up-to-date `origin/main` and keep each PR to one coherent change.
  Branch names are free-form.
- Commit messages and PR titles start with a Conventional Commits type: `feat:`,
  `fix:`, `docs:`, `refactor:`, `test:` or `chore:`. Release PRs use
  `chore: release vX.Y.Z`.
- The PR description follows the template: what changed, why, the exact checks
  that ran, screenshots for visible UI changes and any proof gap.
- The owner reviews every PR. Merge only after the owner explicitly approves that
  PR and its checks are green; address review feedback with new commits on the
  same branch.
- Leave no review comment unattended. Once its suggested action is pushed, resolve
  the thread. If it is declined, unclear or needs discussion, reply in the thread
  so the reviewer sees it and leave it open.
- Merging an owner-approved version-bump PR authorizes automatic release
  publication after checks pass. Ordinary PRs do not publish releases; every
  `main` commit that passes the Nightly workflow replaces the rolling
  `nightly` prerelease, which only `hui update --nightly` installs.
  Create manual recovery tags only when the owner asks.

## Installation and release workflow

- User installation and developer onboarding live in `README.md`, with longer
  user reference in `docs/guide.md`; the fuller contribution loop and release
  checklist live in `CONTRIBUTING.md`.
- A release that adds user-visible features ships with a narrated demo video of
  them: follow [hui-release-video](.agents/skills/hui-release-video/SKILL.md).
- The repository is private and HUI is distributed as a `.tgz`, not through the
  public npm registry. A new machine can clone `main`, run `npm ci` and `npm pack`,
  or download a checksum-paired archive from a GitHub Release once one exists.
- Source iteration uses a feature branch and `npm run dev`/`npm run desktop`.
  Installed-package iteration must include `npm run test:package`; do not run a
  development gateway and an installed gateway against the same PI transcripts.
- Version-bump PRs validate and upload a candidate package, checksum and generated
  changelog covering all changes since the last stable tag. After an approved PR
  merges, the workflow revalidates the `main` commit, creates its matching
  `v<version>` tag and publishes the GitHub Release with that changelog.
  Manual matching-tag runs remain available for explicitly requested recovery.
- Preserve the shared checkout's unrelated work when packaging or documenting a
  release. Never package a dirty checkout by accident.
