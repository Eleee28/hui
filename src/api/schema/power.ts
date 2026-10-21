/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */

export type PowerError = { "error": string; };

export type PowerRequest = { "lidAwake": boolean; };

export type PowerResponse = { "power": (PowerStatus) | (null); };

export type PowerState = { "state": ("off") | ("pending") | ("active") | ("error"); "detail": string; };

export type PowerStatus = { "keepAwake": PowerState; "lidAwake": PowerState; "lidOn": boolean; };
