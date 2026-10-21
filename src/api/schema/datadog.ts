/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */

export type DatadogConnection = { "cli": ({ "installed": false; }) | ({ "installed": true; "version": string; }); "orgs": Array<DatadogOrgStatus>; "pupOrgs": Array<DatadogOrg>; "login": DatadogLoginState; };

export type DatadogError = { "error": string; };

export type DatadogLoginState = ({ "phase": "idle"; }) | ({ "phase": "pending"; "org": DatadogOrg; "url"?: string; "expiresAt": number; }) | ({ "phase": "failed"; "org": DatadogOrg; "message": string; });

export type DatadogOrg = { "name": string; "site": string; };

export type DatadogOrgRequest = { "name"?: string; "site"?: string; };

export type DatadogOrgStatus = { "name": string; "site": string; "status": ("connected") | ("signed_out") | ("unknown"); };

export type DatadogPreview = { "kind": ("share") | ("widget") | ("dashboard"); "url": string; "title": string; "detail"?: string; "org"?: string; "from"?: number; "to"?: number; "relative"?: boolean; "image"?: string; };

export type DatadogPreviewError = ("not_found") | ("signed_out") | ("no_org") | ("cli_missing") | ("unavailable");

export type DatadogPreviewResult = { "url": string; "preview"?: DatadogPreview; "error"?: DatadogPreviewError; "signIn"?: DatadogOrg; };

export type DatadogPreviewsResponse = { "previews": Array<DatadogPreviewResult>; };
