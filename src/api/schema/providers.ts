/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */

export type ProviderAnswerRequest = { "promptId": string; "value": string; };

export type ProviderError = { "error": string; };

export type ProviderLogin = { "id": string; "provider": string; "phase": ("pending") | ("complete") | ("failed") | ("cancelled"); "accountId"?: string; "message"?: string; "url"?: string; "code"?: string; "prompt"?: { "id": string; "type": ("text") | ("secret") | ("select") | ("manual_code"); "message": string; "options"?: Array<{ "id": string; "label": string; }>; }; };

export type ProviderLoginRequest = { "method": ("api_key") | ("oauth"); "name"?: string; "accountId"?: string; };

export type ProviderModel = { "id": string; "name": string; "contextWindow"?: number; "maxTokens"?: number; };

export type ProviderModelsRequest = { "models": Array<string>; };

export type ProviderOk = { "ok": true; };

export type ProviderOrderRequest = { "order": Array<string>; };

export type ProviderQuota = { "status": ("available") | ("unsupported") | ("unavailable"); "message"?: string; "checkedAt": number; "plan"?: string; "email"?: string; "access"?: ("available") | ("limited"); "windows": Array<{ "label": string; "usedPercent": number; "resetAt"?: number; "scope": ("account") | ("scoped") | ("spend"); }>; };

export type ProviderSnapshot = { "providers": Array<ProviderSummary>; "login"?: ProviderLogin; };

export type ProviderSummary = { "id": string; "name": string; "methods": Array<{ "id": ("api_key") | ("oauth"); "label": string; }>; "accounts"?: Array<{ "id": string; "name": string; "email"?: string; "authenticated": boolean; "cooldownUntil"?: number; }>; "configured": boolean; "authenticated": boolean; "selected": Array<string>; "models": Array<ProviderModel>; };
