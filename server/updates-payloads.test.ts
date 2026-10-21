import { expectTypeOf, test } from "vitest";
import type * as Api from "./api/updates.ts";

type LegacyReleaseInfo = { version: string; tag: string; url: string };
type LegacyUpdateCheck = {
  currentVersion: string | null;
  latest: LegacyReleaseInfo | null;
  status: "available" | "current" | "unpublished" | "unavailable";
  canInstall: boolean;
  message: string;
};
type LegacyUpdateJob = {
  id: string;
  pid: number;
  status: "running" | "succeeded" | "failed";
  version: string;
  message: string;
};
type LegacyUpdateSnapshot = { currentVersion: string | null; check: LegacyUpdateCheck | null; job: LegacyUpdateJob | null };

test("updates schemas preserve the existing payload types", () => {
  expectTypeOf<LegacyReleaseInfo>().toMatchTypeOf<Api.ReleaseInfo>();
  expectTypeOf<Api.ReleaseInfo>().toMatchTypeOf<LegacyReleaseInfo>();
  expectTypeOf<LegacyUpdateCheck>().toMatchTypeOf<Api.UpdateCheck>();
  expectTypeOf<Api.UpdateCheck>().toMatchTypeOf<LegacyUpdateCheck>();
  expectTypeOf<LegacyUpdateJob>().toMatchTypeOf<Api.UpdateJob>();
  expectTypeOf<Api.UpdateJob>().toMatchTypeOf<LegacyUpdateJob>();
  expectTypeOf<LegacyUpdateSnapshot>().toMatchTypeOf<Api.UpdateSnapshot>();
  expectTypeOf<Api.UpdateSnapshot>().toMatchTypeOf<LegacyUpdateSnapshot>();
});
