# Browser UI Guide

This directory owns the Lit application, browser-side stores, views, and visual
tokens. It consumes typed HUI APIs; it does not own PI or filesystem behavior.

## Boundaries

- `hui-app.ts` owns the route and the layout; each feature's state lives in a Lit
  controller in `controllers/`. Keep reusable normalization in `lib/`, and caches or
  write queues in `lib/**/*-store.ts`; keep `views/` focused on rendering and
  emitting explicit callbacks.
- `api/` holds stateless request functions, one module per API area. Payload types
  come from `api/schema/`, which `npm run api:schema` generates from the server's
  published schema (`docs/api.schema.json`): never edit it or redeclare a payload
  by hand. Handle loading, empty, error, streaming, and reconnect states
  explicitly; never present an optimistic success as confirmed backend state.
- Reuse tokens from `styles/tokens.css` and established components/classes before
  adding one-off styling. Preserve keyboard operation, visible focus, labels, and
  responsive behavior while matching the OpenClaw reference UI.
- Do not use Node APIs or read PI files from browser code (`tsconfig.web.json`
  type-checks `src/` without Node types). Requests go through `api/request.ts`,
  which adds the local-client header.

## Tests and visual proof

- Unit-test deterministic stores, normalizers, parsers, and catalog rules beside
  their owners with Vitest. Test behavior rather than Lit implementation details:
  render views and drive controllers with fake deps; never read `hui-app.ts` or
  `controllers/` as text (R13).
- Every user-visible change requires Browser-tool E2E proof in the real app: navigate
  from a user-reachable entry, exercise the changed interaction, inspect the final
  rendered state, and check relevant responsive/keyboard states.
- Run focused tests, `npm test`, `npm run typecheck`, and `npm run build` before
  handoff. Capture and report browser console/runtime errors rather than ignoring them.
