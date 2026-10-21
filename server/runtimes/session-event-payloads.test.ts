import { expectTypeOf, test } from "vitest";
import type * as Api from "../api/session-events.ts";

type LegacyRuntimeQueue = {
  steering: readonly string[];
  followUp: readonly string[];
  items?: readonly LegacyQueuedMessage[];
};

type LegacyQueuedMessage = {
  id: string;
  text: string;
  mode: "followUp";
};

type LegacyRuntimeQuestion =
  | {
      id: string;
      method: "select";
      title: string;
      message?: string;
      options: readonly string[];
      timeout?: number;
    }
  | {
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
    }
  | {
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
    }
  | {
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
      timeout?: number;
    };

type LegacyCompactionReason = "manual" | "threshold" | "overflow";

type LegacyRuntimeCompaction = {
  status: "running" | "failed" | "cancelled";
  reason: LegacyCompactionReason;
  message?: string;
  blocking?: false;
  background?: true;
};

type LegacyRuntimeModel = {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevels?: readonly string[];
  fast?: true;
};

type LegacyRuntimeCommand = {
  name: string;
  description: string;
  source: "extension" | "skill" | "prompt";
};

type LegacyRuntimeUsage = {
  contextTokens: number | null;
  contextWindow: number;
  percent: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
};

test("the session event schemas preserve the runtime types they replace", () => {
  expectTypeOf<LegacyRuntimeQueue>().toMatchTypeOf<Api.RuntimeQueue>();
  expectTypeOf<Api.RuntimeQueue>().toMatchTypeOf<LegacyRuntimeQueue>();
  expectTypeOf<LegacyQueuedMessage>().toMatchTypeOf<Api.QueuedMessage>();
  expectTypeOf<Api.QueuedMessage>().toMatchTypeOf<LegacyQueuedMessage>();
  expectTypeOf<LegacyRuntimeQuestion>().toMatchTypeOf<Api.RuntimeQuestion>();
  expectTypeOf<Api.RuntimeQuestion>().toMatchTypeOf<LegacyRuntimeQuestion>();
  expectTypeOf<LegacyCompactionReason>().toMatchTypeOf<Api.CompactionReason>();
  expectTypeOf<Api.CompactionReason>().toMatchTypeOf<LegacyCompactionReason>();
  expectTypeOf<LegacyRuntimeCompaction>().toMatchTypeOf<Api.RuntimeCompaction>();
  expectTypeOf<Api.RuntimeCompaction>().toMatchTypeOf<LegacyRuntimeCompaction>();
  expectTypeOf<LegacyRuntimeModel>().toMatchTypeOf<Api.RuntimeModel>();
  expectTypeOf<Api.RuntimeModel>().toMatchTypeOf<LegacyRuntimeModel>();
  expectTypeOf<LegacyRuntimeCommand>().toMatchTypeOf<Api.RuntimeCommand>();
  expectTypeOf<Api.RuntimeCommand>().toMatchTypeOf<LegacyRuntimeCommand>();
  expectTypeOf<LegacyRuntimeUsage>().toMatchTypeOf<Api.RuntimeUsage>();
  expectTypeOf<Api.RuntimeUsage>().toMatchTypeOf<LegacyRuntimeUsage>();
});
