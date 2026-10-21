/** Checks real API responses against their TypeBox schemas in tests, never in request handling. */
import assert from "node:assert/strict";
import type { Static, TSchema } from "typebox";
import Value from "typebox/value";

export function expectSchema<S extends TSchema>(schema: S, value: unknown): asserts value is Static<S> {
  if (!Value.Check(schema, value)) assert.fail(JSON.stringify(Value.Errors(schema, value), null, 2));
}
