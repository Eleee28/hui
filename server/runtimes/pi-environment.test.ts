import assert from "node:assert/strict";
import { test } from "vitest";
import { piEnvironment } from "./pi-environment.ts";

test("PI child environment preserves explicit identity and inherited variables", () => {
  const base = { PI_CLIENT_SESSION_ID: "operator-id", OTHER_SETTING: "retained" };
  assert.deepEqual(piEnvironment(base), base);
  assert.notEqual(piEnvironment({ PI_CLIENT_SESSION_ID: " " })["PI_CLIENT_SESSION_ID"], " ");
  assert.notEqual(piEnvironment({})["PI_CLIENT_SESSION_ID"], piEnvironment({})["PI_CLIENT_SESSION_ID"]);
});
