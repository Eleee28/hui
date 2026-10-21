import { expectTypeOf, test } from "vitest";
import type * as Api from "../api/datadog.ts";

type LegacyDatadogPreview = {
  kind: "share" | "widget" | "dashboard";
  url: string;
  title: string;
  detail?: string;
  org?: string;
  from?: number;
  to?: number;
  relative?: boolean;
  image?: string;
};
type LegacyDatadogPreviewError = "not_found" | "signed_out" | "no_org" | "cli_missing" | "unavailable";
type LegacyDatadogPreviewResult = { url: string; preview?: LegacyDatadogPreview; error?: LegacyDatadogPreviewError; signIn?: LegacyDatadogOrg };
type LegacyDatadogOrg = { name: string; site: string };
type LegacyDatadogOrgStatus = LegacyDatadogOrg & { status: "connected" | "signed_out" | "unknown" };
type LegacyDatadogLoginState =
  | { phase: "idle" }
  | { phase: "pending"; org: LegacyDatadogOrg; url?: string; expiresAt: number }
  | { phase: "failed"; org: LegacyDatadogOrg; message: string };
type LegacyDatadogConnection = {
  cli: { installed: false } | { installed: true; version: string };
  orgs: LegacyDatadogOrgStatus[];
  pupOrgs: LegacyDatadogOrg[];
  login: LegacyDatadogLoginState;
};

test("the schemas preserve the existing datadog payload types", () => {
  expectTypeOf<LegacyDatadogPreview>().toMatchTypeOf<Api.DatadogPreview>();
  expectTypeOf<Api.DatadogPreview>().toMatchTypeOf<LegacyDatadogPreview>();
  expectTypeOf<LegacyDatadogPreviewError>().toMatchTypeOf<Api.DatadogPreviewError>();
  expectTypeOf<Api.DatadogPreviewError>().toMatchTypeOf<LegacyDatadogPreviewError>();
  expectTypeOf<LegacyDatadogPreviewResult>().toMatchTypeOf<Api.DatadogPreviewResult>();
  expectTypeOf<Api.DatadogPreviewResult>().toMatchTypeOf<LegacyDatadogPreviewResult>();
  expectTypeOf<LegacyDatadogOrg>().toMatchTypeOf<Api.DatadogOrg>();
  expectTypeOf<Api.DatadogOrg>().toMatchTypeOf<LegacyDatadogOrg>();
  expectTypeOf<LegacyDatadogOrgStatus>().toMatchTypeOf<Api.DatadogOrgStatus>();
  expectTypeOf<Api.DatadogOrgStatus>().toMatchTypeOf<LegacyDatadogOrgStatus>();
  expectTypeOf<LegacyDatadogLoginState>().toMatchTypeOf<Api.DatadogLoginState>();
  expectTypeOf<Api.DatadogLoginState>().toMatchTypeOf<LegacyDatadogLoginState>();
  expectTypeOf<LegacyDatadogConnection>().toMatchTypeOf<Api.DatadogConnection>();
  expectTypeOf<Api.DatadogConnection>().toMatchTypeOf<LegacyDatadogConnection>();
});
