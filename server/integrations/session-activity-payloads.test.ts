import { expectTypeOf, test } from "vitest";
import type * as Api from "../api/github.ts";


type LegacyActivityBlock = {

  start: number;
  end: number;

  model?: string;

  firstMessage?: string;
};

type LegacyActivitySession = {
  id: string;
  title: string;
  group: string;

  project: string;
  archived?: boolean;
  blocks: LegacyActivityBlock[];
};

type LegacySessionActivity = { sessions: LegacyActivitySession[] };

test("the session activity schema preserves its existing public types", () => {
  expectTypeOf<LegacyActivityBlock>().toMatchTypeOf<Api.ActivityBlock>();
  expectTypeOf<Api.ActivityBlock>().toMatchTypeOf<LegacyActivityBlock>();
  expectTypeOf<LegacyActivitySession>().toMatchTypeOf<Api.ActivitySession>();
  expectTypeOf<Api.ActivitySession>().toMatchTypeOf<LegacyActivitySession>();
  expectTypeOf<LegacySessionActivity>().toMatchTypeOf<Api.SessionActivity>();
  expectTypeOf<Api.SessionActivity>().toMatchTypeOf<LegacySessionActivity>();
});
