import { expectTypeOf, test } from "vitest";
import type * as Api from "./api/workers.ts";

type LegacyWorkerState = "disconnected" | "connecting" | "connected" | "error";

type LegacyWorkerView = {
  id: string;
  name: string;
  command: string;
  extraPaths: string[];
  state: LegacyWorkerState;
  phase?: string;
  error?: string;
  host?: { hostname: string; platform: string; arch: string; node: string; home: string; release: string };
  sync?: { at: string; files: number; uploaded: number; deleted: number; installed: string[]; skipped: string[]; errors: string[] };
};

type LegacyWorkerInput = { name: string; command: string; extraPaths?: string[] };


test("workers schemas preserve the existing payload types", () => {
  expectTypeOf<LegacyWorkerState>().toMatchTypeOf<Api.WorkerState>();
  expectTypeOf<Api.WorkerState>().toMatchTypeOf<LegacyWorkerState>();
  expectTypeOf<LegacyWorkerView>().toMatchTypeOf<Api.WorkerView>();
  expectTypeOf<Api.WorkerView>().toMatchTypeOf<LegacyWorkerView>();
  expectTypeOf<LegacyWorkerInput>().toMatchTypeOf<Api.WorkerInput>();
  expectTypeOf<Api.WorkerInput>().toMatchTypeOf<LegacyWorkerInput>();
});
