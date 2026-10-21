import type { JiraParentCandidate } from "../../server/api/jira.ts";
import type { TranscriptEntry } from "../../server/runtimes/types.ts";
import { interruptedRunPrompt } from "../../server/sessions/interrupted-run.ts";
import { CONTINUE_PROMPT } from "../../server/agent-tools/subagent-completion.ts";
import { CONTINUE_AFTER_ERROR_PROMPT } from "../../server/sessions/digest.ts";
import { assistant, bash, edit, read, step, thinking, user, write } from "./transcript.ts";
import { ciFailuresTail, gitQuestionsTail, lintCleanupTail, stylingTail } from "./tails.ts";

/**
 * Synthetic sessions for the Jira draft eval. Each case encodes one way a
 * drafter can lose the session's goal: a long unrelated tail, resume prompts,
 * a mid-session scope change, pull request chatter, side questions or a
 * tempting parent. All projects, people and code are invented.
 */
export type DraftCase = {
  id: string;
  /** What failure mode the case guards against. */
  why: string;
  title: string;
  project: string;
  parents: JiraParentCandidate[];
  entries: TranscriptEntry[];
  expect: {
    /** Every pattern must match the summary. */
    summary: RegExp[];
    /** No pattern may match the summary. */
    summaryNot?: RegExp[];
    /** Every pattern must match the description. */
    description?: RegExp[];
    /** No pattern may match the description. */
    descriptionNot?: RegExp[];
    /** Acceptable parent keys; "" means no parent. */
    parent: string[];
  };
};

const epic = (key: string, summary: string): JiraParentCandidate => ({ key, summary, issueType: "Epic", hierarchyLevel: 1 });

const webhookRetries: DraftCase = {
  id: "webhook-retries-lint-tail",
  why: "Long feature session that ends with unrelated lint and flaky-test cleanup.",
  title: "relay work",
  project: "REL",
  parents: [
    epic("REL-4", "Reliable webhook delivery"),
    epic("REL-9", "Developer tooling and CI hygiene"),
    epic("UI-2", "Dashboard refresh"),
  ],
  entries: [
    user("In the relay service, webhook deliveries currently fail permanently on the first 5xx or timeout. Add retries with exponential backoff and full jitter (max 6 attempts, delay capped at 10 minutes), persist the attempt count so retries survive a worker restart, and move deliveries that exhaust their retries to a dead-letter table we can inspect and replay from the admin CLI."),
    ...step("I read the delivery worker first. Today src/delivery/worker.ts pulls a job, POSTs the payload with a 10 second timeout and marks the row 'failed' on any non-2xx status or network error. There is no attempt counter and no scheduling column, so a retry would have to be a new row. The queue table is deliveries(id, endpoint_id, payload, status, created_at). I'll add attempt and next_attempt_at columns, and a partial index on next_attempt_at for pending rows so the poller stays cheap.", [read("src/delivery/worker.ts"), read("src/delivery/queue.ts"), read("migrations/0041_endpoints.sql")]),
    ...step("Added migration 0042_delivery_attempts.sql: attempt integer not null default 0, next_attempt_at timestamptz, last_error text, plus the partial index on (next_attempt_at) where status = 'pending'. The migration is additive and backfills next_attempt_at = created_at for pending rows so nothing already queued is stranded.", [write("migrations/0042_delivery_attempts.sql"), bash("npm run db:migrate -- --dry-run", "0042_delivery_attempts.sql ... ok")]),
    ...step("Implemented the backoff policy in src/delivery/backoff.ts as a pure function so it is easy to test:\n\n~~~ts\nexport function nextDelayMs(attempt: number, random = Math.random): number {\n  const base = 2_000 * 2 ** attempt;\n  return Math.round(random() * Math.min(base, 600_000));\n}\n~~~\n\nFull jitter keeps a burst of failing endpoints from retrying in lockstep. Attempts are zero-based, so the sixth attempt is the last one.", [write("src/delivery/backoff.ts")]),
    ...step("Wired the worker to the policy. Retryable outcomes are 5xx, 408, 429 and network timeouts; 4xx other than those fail immediately because retrying a 400 or 410 will never succeed. On a retryable failure the worker increments attempt, stores last_error and sets next_attempt_at = now() + nextDelayMs(attempt). A 429 with Retry-After uses the larger of the header and the computed delay. The poller now selects pending rows whose next_attempt_at is due, using SKIP LOCKED so two workers never take the same row.", [edit("src/delivery/worker.ts"), edit("src/delivery/queue.ts")]),
    ...step("Restart safety: because attempt and next_attempt_at are persisted before the worker acknowledges the job, a crash mid-delivery just means the row is picked up again when due. I also made the POST idempotent from the receiver's side by sending an Idempotency-Key header equal to the delivery id, so a delivery that succeeded right before a crash is safe to resend.", [edit("src/delivery/worker.ts")]),
    ...step("Dead letters: when attempt reaches 6 the worker moves the row to a new delivery_dead_letters table (same columns plus failed_at and final_error) inside one transaction, so a row is never in both tables. Added src/delivery/dead-letter.ts with list, show and replay helpers; replay re-inserts the row into deliveries with attempt reset to 0 and records who replayed it.", [write("src/delivery/dead-letter.ts"), edit("migrations/0042_delivery_attempts.sql")]),
    ...step("Admin CLI: relay dead-letter list [--endpoint ID] [--since 24h], relay dead-letter show ID and relay dead-letter replay ID|--endpoint ID. Replay by endpoint is capped at 500 rows per call and asks for confirmation unless --yes is passed. Output is a table by default and JSON with --json.", [write("cli/commands/dead-letter.ts"), edit("cli/index.ts")]),
    ...step("Tests: backoff.test.ts checks the cap, the growth and that jitter stays inside [0, cap]; worker.test.ts covers retryable versus terminal statuses, Retry-After handling, persistence across a simulated restart and the move to dead letters after the sixth failure; dead-letter.test.ts covers replay. All 38 delivery tests pass locally.", [write("src/delivery/backoff.test.ts"), edit("src/delivery/worker.test.ts"), write("src/delivery/dead-letter.test.ts"), bash("npm test -- src/delivery", "38 passing")]),
    ...step("Docs: added a Retries and dead letters section to docs/webhooks.md with the schedule (roughly 2s, 4s, 8s, 16s, 32s, 64s before jitter, capped at 10 minutes), which statuses are retried, and the CLI commands. Also noted that receivers should dedupe on the Idempotency-Key header.", [edit("docs/webhooks.md")]),
    ...lintCleanupTail(),
  ],
  expect: {
    summary: [/retr(y|ies)|backoff/i, /webhook|deliver/i],
    summaryNot: [/lint|eslint|snapshot|flak|header/i],
    description: [/dead.?letter/i],
    parent: ["REL-4"],
  },
};

const tomlConfig: DraftCase = {
  id: "toml-config-resume-prompts",
  why: "Session interrupted and resumed several times; resume prompts must not read as the task.",
  title: "config",
  project: "TIDY",
  parents: [epic("TIDY-1", "Plugin marketplace"), epic("TIDY-7", "Windows support")],
  entries: [
    user("Switch the tidy CLI's config loading from YAML to TOML. Keep reading ~/.config/tidy/config.yaml for one release with a deprecation warning, add a 'tidy config migrate' command that converts the YAML file to config.toml, and update the docs."),
    ...step("Config is loaded in src/config/load.ts with js-yaml, validated by a zod schema in src/config/schema.ts. I'll swap the parser for smol-toml, keep the schema as the single source of truth, and make the loader look for config.toml first and fall back to config.yaml.", [read("src/config/load.ts"), read("src/config/schema.ts")]),
    ...step("Loader rewritten: config.toml wins when both exist (with a warning that config.yaml is ignored); config.yaml alone still loads and prints 'config.yaml is deprecated and will stop loading in tidy 3.0; run tidy config migrate'. The warning is printed once per process, to stderr, so scripts parsing stdout are unaffected.", [edit("src/config/load.ts"), edit("package.json")]),
    { kind: "error", message: "Connection to the model provider was lost." },
    user(interruptedRunPrompt("Switch the tidy CLI's config loading from YAML to TOML. Keep reading ~/.config/tidy/config.yaml for one release with a deprecation warning, add a 'tidy config migrate' command that converts the YAML file to config.toml, and update the docs.")),
    ...step("Resuming. The loader changes are in place. Next is the migrate command: it reads config.yaml, validates it with the same schema, writes config.toml with keys in schema order and comments carried over as TOML comments where js-yaml exposes them, and refuses to overwrite an existing config.toml unless --force is given. The YAML file is renamed to config.yaml.bak rather than deleted.", [write("src/commands/config-migrate.ts"), edit("src/commands/index.ts")]),
    ...step("Tests for the loader precedence, the deprecation warning and the migrate command (round trip, --force, invalid YAML). 54 passing.", [write("src/config/load.test.ts"), write("src/commands/config-migrate.test.ts"), bash("npm test", "54 passing")]),
    { kind: "error", message: "429 Too Many Requests: rate limit exceeded, retry after 20s" },
    user(CONTINUE_AFTER_ERROR_PROMPT),
    ...step("Continuing after the rate limit. Updated docs/configuration.md with TOML examples for every section, a Migrating from YAML section and the deprecation timeline, and added a CHANGELOG entry.", [edit("docs/configuration.md"), edit("CHANGELOG.md")]),
    user(CONTINUE_PROMPT),
    assistant("The original task is already complete: TOML loading with YAML fallback and a deprecation warning, the tidy config migrate command, tests and docs are all done. Nothing left to continue."),
  ],
  expect: {
    summary: [/toml/i],
    summaryNot: [/continu|resum|interrupt|rate.?limit|429/i],
    description: [/migrat/i, /deprecat/i],
    parent: [""],
  },
};

const csvExport: DraftCase = {
  id: "invoice-export-scope-change",
  why: "The user narrows the goal mid-session; the draft must reflect the change, not the first plan.",
  title: "invoice export",
  project: "BILL",
  parents: [epic("BILL-3", "Self-serve reporting"), epic("BILL-8", "Payment provider migration"), epic("PLAT-1", "Memory and performance budget")],
  entries: [
    user("Add an invoice export to the billing dashboard: CSV and JSON, filtered by date range and status, downloadable from the Invoices page."),
    ...step("Plan: a GET /api/invoices/export?format=csv|json&from&to&status endpoint, a shared query builder with the existing list filters, and an Export menu on the Invoices page. I started with the query builder and both serializers.", [write("server/invoices/export.ts"), write("server/invoices/serializers.ts")]),
    ...step("Both formats work for small accounts. JSON returns an array of invoice objects; CSV has a header row and ISO dates. The Export menu has CSV and JSON items.", [write("web/invoices/ExportMenu.tsx")]),
    user("Change of plan: drop the JSON export entirely, product only wants CSV. But it has to stream. Some accounts have 400k invoices and the current approach loads everything into memory."),
    ...step("Removed the JSON serializer and the menu item; the endpoint now only accepts format=csv (the format parameter is gone). The export streams: a server-side cursor fetches 2,000 rows at a time and pipes them through a CSV transform to the response, with Content-Disposition: attachment. Memory stays flat at about 40 MB on a seeded 400k-invoice account, down from 1.9 GB.", [edit("server/invoices/export.ts"), edit("server/invoices/serializers.ts"), edit("web/invoices/ExportMenu.tsx")]),
    ...step("Tests cover filters, CSV escaping of commas and quotes, and a streaming test that asserts the first bytes arrive before the query finishes. All green.", [write("server/invoices/export.test.ts"), bash("npm test -- invoices", "17 passing")]),
  ],
  expect: {
    summary: [/csv/i, /export/i],
    summaryNot: [/json/i],
    description: [/stream/i],
    parent: ["BILL-3"],
  },
};

const darkMode: DraftCase = {
  id: "dark-mode-pr-chatter",
  why: "Session ends in commit, pull request and CI chatter that should not become the title.",
  title: "settings",
  project: "WEB",
  parents: [epic("WEB-5", "Accessibility and theming"), epic("WEB-9", "CI speedups"), epic("WEB-2", "Onboarding")],
  entries: [
    user("Add a dark mode toggle to the settings page. Default to the OS preference, let people override it with light, dark or system, persist the choice in localStorage and avoid a flash of the wrong theme on page load."),
    ...step("Theme colors are hardcoded in a few places but most components already use CSS variables from src/styles/tokens.css. I'll add a [data-theme=dark] token set, a ThemeProvider that resolves system via matchMedia('(prefers-color-scheme: dark)') and listens for changes, and a small inline script in index.html that sets data-theme before first paint.", [read("src/styles/tokens.css"), read("index.html")]),
    ...step("Added the dark token set and replaced the 14 hardcoded colors I found with variables. The inline script reads localStorage['theme'] (light, dark or system), resolves system with matchMedia and sets document.documentElement.dataset.theme synchronously, so there is no flash.", [edit("src/styles/tokens.css"), edit("index.html"), edit("src/components/Card.tsx"), edit("src/components/Chart.tsx")]),
    ...step("Settings > Appearance now has a three-way segmented control. Changing it updates the provider, localStorage and the data attribute; choosing System follows live OS changes. Charts re-read their palette from the variables on theme change.", [write("src/theme/ThemeProvider.tsx"), edit("src/pages/Settings.tsx")]),
    ...step("Tests: provider resolution for each choice, the live system listener, persistence, and a Playwright check that the first paint already has the stored theme. Contrast checks pass WCAG AA for text in both themes.", [write("src/theme/ThemeProvider.test.tsx"), write("e2e/theme.spec.ts"), bash("npm test && npx playwright test e2e/theme.spec.ts", "all passed")]),
    ...ciFailuresTail(),
  ],
  expect: {
    summary: [/dark|theme/i],
    summaryNot: [/\bPR\b|pull request|merge|commit|\bCI\b|e2e/i],
    description: [/localStorage|persist/i],
    descriptionNot: [/PR #|pull request|merged?\b|approved/i],
    parent: ["WEB-5"],
  },
};

const backupIndex: DraftCase = {
  id: "backup-investigation-redirect",
  why: "An investigation whose user explicitly redefines the ticket at the end; the drafter must follow that redirection.",
  title: "slow backups",
  project: "OPS",
  parents: [epic("OPS-2", "Database performance"), epic("OPS-6", "Backup and disaster recovery"), epic("OPS-9", "On-call tooling")],
  entries: [
    user("The nightly backup job went from 40 minutes to over 3 hours in the last two weeks. Can you figure out why? Don't change anything yet."),
    ...step("The job has three phases: pg_dump of the core schema, a per-tenant export of the events table to object storage, and verification. Timings from the job logs over 20 nights: pg_dump is flat at about 18 minutes, verification about 6 minutes, and the events export grew from 16 minutes to 2 hours 50 minutes starting on the 9th.", [bash("jq '.phases' logs/backup-*.json | head -80", "…")]),
    ...step("What changed on the 9th: migration 0088 added a tenant_id column to events (previously tenants were resolved through a join on sessions) but did not add an index. The export runs SELECT * FROM events WHERE tenant_id = $1 AND created_at >= $2 once per tenant, about 1,900 tenants, and EXPLAIN shows a sequential scan over 410M rows each time.", [bash("psql -c 'EXPLAIN ANALYZE SELECT * FROM events WHERE tenant_id = 42 AND created_at >= now() - interval 1 day'", "Seq Scan on events … actual time=5231.8")]),
    ...step("So the regression is the missing index plus a query pattern that multiplies it by the tenant count. A composite index on events(tenant_id, created_at) would make each query an index range scan; batching tenants (for example 100 per query with tenant_id = ANY($1)) would also cut round trips. I have not changed anything.", []),
    user("Makes sense. The ticket should be to add the index on events(tenant_id, created_at), created concurrently, and batch the per-tenant export query. The investigation itself is done, don't make that the ticket."),
    assistant("Understood. The follow-up work is the concurrent index on events(tenant_id, created_at) and batching the per-tenant export query; the investigation is complete."),
  ],
  expect: {
    summary: [/index|batch/i],
    summaryNot: [/investigat|figure out|\bwhy\b/i],
    description: [/tenant_id/i],
    parent: ["OPS-2", "OPS-6"],
  },
};

const renameField: DraftCase = {
  id: "rename-field-short",
  why: "Short session; a baseline for the easy path.",
  title: "Rename userId to accountId in billing v2",
  project: "API",
  parents: [epic("API-1", "API v2 consistency"), epic("API-4", "Partner webhooks")],
  entries: [
    user("Rename userId to accountId in the billing API v2 responses. v1 must stay untouched."),
    ...step("Renamed the field in the v2 serializers for invoices, subscriptions and payment methods; v1 serializers are separate and unchanged. Contract tests updated for v2 only.", [edit("api/v2/billing/serializers.ts"), edit("api/v2/billing/serializers.test.ts")]),
    user("also update the OpenAPI spec"),
    ...step("Updated openapi/v2.yaml: userId is now accountId in the three schemas, and the changelog notes the breaking change for v2 clients.", [edit("openapi/v2.yaml"), edit("CHANGELOG.md")]),
  ],
  expect: {
    summary: [/accountId|rename/i],
    description: [/v2/i],
    parent: ["API-1"],
  },
};

const oktaSso: DraftCase = {
  id: "okta-sso-css-tail",
  why: "Feature session with a long styling tail and a tempting UI parent.",
  title: "admin login",
  project: "AUTH",
  parents: [epic("AUTH-12", "Enterprise authentication (SSO, SCIM)"), epic("UI-7", "Admin portal redesign"), epic("OPS-3", "Observability revamp")],
  entries: [
    user("Add SSO login to the admin portal with Okta over OIDC. Admins with an @acme.test email must use SSO; keep password login only for the break-glass account."),
    ...step("The portal uses a session cookie issued by server/auth/password.ts. I'll add an OIDC authorization code flow with PKCE using the openid-client library, map the Okta subject and email to the existing admins table, and enforce SSO by email domain in the login handler.", [read("server/auth/password.ts"), read("server/auth/session.ts")]),
    ...step("Added server/auth/oidc.ts with /auth/oidc/start and /auth/oidc/callback. State and the PKCE verifier live in a short-lived signed cookie. The callback verifies the ID token (issuer, audience, nonce, expiry), looks up the admin by email and issues the normal session cookie. Unknown emails get a 403 page rather than auto-provisioning.", [write("server/auth/oidc.ts"), edit("server/routes.ts")]),
    ...step("Enforcement: POST /auth/password now rejects @acme.test emails with a message pointing to SSO, except the account flagged break_glass = true in the admins table. Added a migration for that flag and an audit log entry for every break-glass login.", [edit("server/auth/password.ts"), write("migrations/0017_break_glass.sql")]),
    ...step("Config via OKTA_ISSUER, OKTA_CLIENT_ID and OKTA_CLIENT_SECRET, documented in docs/admin-sso.md with the Okta app settings (redirect URI, grant type, scopes openid email profile). Tests mock the issuer with a local JWKS and cover the happy path, a bad nonce, an expired token, an unknown email and the break-glass exception.", [write("docs/admin-sso.md"), write("server/auth/oidc.test.ts"), bash("npm test -- auth", "21 passing")]),
    ...stylingTail(),
  ],
  expect: {
    summary: [/sso|okta|oidc|single sign/i],
    summaryNot: [/css|spacing|button|align|mobile|divider|icon/i],
    description: [/break.?glass/i],
    parent: ["AUTH-12"],
  },
};

const cliTypo: DraftCase = {
  id: "cli-typo-no-parent",
  why: "Tiny chore with no fitting parent; the drafter must leave the parent empty.",
  title: "typo",
  project: "CLI",
  parents: [epic("PAY-1", "Payment retries"), epic("MOB-4", "Mobile offline mode")],
  entries: [
    user("The --verbose help text in the CLI says 'verbsoe'. Fix it and check the other flags for typos."),
    ...step("Fixed 'verbsoe' in the --verbose help and found one more: --dry-run said 'wihtout'. No other typos in the flag help after a spellcheck pass over src/cli/flags.ts.", [edit("src/cli/flags.ts"), bash("npx cspell src/cli/flags.ts", "0 issues")]),
  ],
  expect: {
    summary: [/typo|help|spelling/i],
    parent: [""],
  },
};

const rateLimit: DraftCase = {
  id: "rate-limit-side-questions",
  why: "Feature session that ends in unrelated side questions about Git.",
  title: "api limits",
  project: "API",
  parents: [epic("API-3", "Public API hardening"), epic("DX-2", "Git workflow documentation"), epic("MOB-4", "Mobile offline mode")],
  entries: [
    user("Implement per-API-key rate limiting on the public API: token bucket, 100 requests per minute by default, configurable per plan, respond 429 with a Retry-After header, and back it with Redis so it works across instances."),
    thinking("A Lua script keeps the bucket update atomic in Redis."),
    ...step("Added server/ratelimit/bucket.lua: one atomic script that refills tokens based on elapsed time, takes one if available and returns remaining tokens and the wait in milliseconds. Keys are rl:{apiKeyId} with a TTL of twice the refill window so idle keys expire.", [write("server/ratelimit/bucket.lua"), write("server/ratelimit/redis.ts")]),
    ...step("Middleware in server/ratelimit/middleware.ts runs after API key auth, reads the plan limits (free 100/min, team 1,000/min, enterprise configurable) and sets X-RateLimit-Limit, X-RateLimit-Remaining and, when throttled, a 429 with Retry-After in seconds. If Redis is unreachable the middleware fails open and increments a metric, so an outage never blocks the API.", [write("server/ratelimit/middleware.ts"), edit("server/app.ts"), edit("server/plans.ts")]),
    ...step("Tests with a real Redis in the test container: refill math, concurrency (200 parallel requests take exactly 100 tokens), per-plan limits, headers, Retry-After and fail-open. Load test at 5k rps shows 0.4 ms p99 overhead.", [write("server/ratelimit/middleware.test.ts"), bash("npm test -- ratelimit", "26 passing")]),
    ...gitQuestionsTail(),
  ],
  expect: {
    summary: [/rate.?limit|throttl|token bucket/i],
    summaryNot: [/rebase|squash|\bgit\b|branch/i],
    description: [/429|retry-after/i, /redis/i],
    parent: ["API-3"],
  },
};

export const DRAFT_CASES: readonly DraftCase[] = [
  webhookRetries,
  tomlConfig,
  csvExport,
  darkMode,
  backupIndex,
  renameField,
  oktaSso,
  cliTypo,
  rateLimit,
];
