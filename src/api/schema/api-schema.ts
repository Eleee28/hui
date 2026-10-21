/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */

export type ApiSchemaDocument = { "$schema": "https://json-schema.org/draft/2020-12/schema"; "$defs": Record<string, unknown>; "x-hui-api-version": string; "x-hui-areas": Record<string, Array<string>>; "x-hui-routes": Array<ApiSchemaRoute>; };

export type ApiSchemaError = { "error": string; };

export type ApiSchemaReference = { "$ref": string; };

export type ApiSchemaRoute = { "method": string; "path": string; "request"?: ApiSchemaReference; "response": ApiSchemaReference; "events"?: ApiSchemaReference; };
