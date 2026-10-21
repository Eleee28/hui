# Server Guide

This directory owns HUI's local HTTP API, persisted HUI registry, PI configuration
reads, long-lived session lifecycle, and runtime adapters.

## Boundaries

- `hui.ts` owns `/__hui/` dispatch: the `x-hui` gate, the diagnostics hook and the
  order in which route modules are tried. Order is behavior; `routes/order.test.ts`
  pins it. `services.ts` builds the services at import time, in dependency order;
  `backend.ts` starts and stops them; `vite-plugin.ts` serves all of it from Vite.
- Each area's routes live in `routes/<area>.ts` as `createXRoutes(deps)`, returning
  `{ handle(request: RouteRequest) }` (`http/route.ts`). `deps` names only what the
  module uses, passed in by `services.ts`. `handle` returns `undefined` when the path
  is not its own, or a `RouteResult` (JSON through `reply(schema, body)`, HTML or a
  file) that `hui.ts` writes. Keep parsing, validation and status mapping in the
  route module; move lifecycle and persistence rules to their owning modules.
- Every JSON payload a route sends or receives has a TypeBox schema in
  `api/<area>.ts`, listed in the module's `routeSchemas`, and every route has a
  heading in `docs/api.md`. After changing either, run `npm run api:schema`, which
  rewrites `docs/api.schema.json` and the browser's generated types;
  `scripts/api-schema.test.ts` fails on a gap or a stale file. Schemas describe
  payloads; they don't validate requests. Internal records never get one.
- Bots live in `bots/`, and the Durable core in `runtimes/` never imports
  them (R8). `services.ts` and `worker/host-bots.ts` hand their Durable host the
  bots' extension with `configureDurableBots`; a host without bots passes `null`
  (`cli/doctor-pi-sessions.ts`), and a host opened before either call throws.
- `sessions/sessions.ts` owns HUI registry persistence. `sessions/live-sessions.ts` owns
  the one-live-runtime-per-session invariant. `runtimes/` translates a harness protocol into the
  generic types in `runtimes/types.ts`.
- PI files and transcripts are externally owned: read them through explicit adapters
  and never rename, rewrite, or delete them. HUI writes only HUI-owned state.
- Validate all browser input at the server boundary. Preserve the `x-hui` local-
  client guard, request size limits, path constraints, and bounded external fetches.
- Runtime exits and malformed protocol messages must become explicit session/error
  events; they must not crash the HUI server or invent successful state.

## Tests

- Keep `*.test.ts` beside its owner and use Vitest plus `node:assert/strict` assertions.
- Use temporary directories, synthetic config/transcripts, and controllable fake
  runtimes. Never mutate real `~/.pi` or `~/.config/hui` data in a test.
- Prove lifecycle edges: duplicate opens, busy prompts, abort/exit, reconnect,
  persistence failure, and cleanup. Wait for emitted state; do not use arbitrary sleeps.
- State a test cannot await is polled with `waitFor` (`test-support/wait-for.ts`):
  a wall-clock deadline, setTimeout between reads, and the awaited state in its
  failure. Never re-poll with setImmediate or an iteration count.
- A JSON-lines log another process may still be appending to is parsed through
  `completeLines` (`test-support/json-lines.ts`), never up to a half-written line.
- Run the focused test file, then `npm test` and `npm run typecheck`. Changes to
  routes or runtime behavior also require Browser-tool E2E proof of the consuming flow.
