/** Public metadata describing the gateway's published JSON Schema document and its route references. */
import { Type, type Static } from "typebox";

export const ApiSchemaReference = Type.Object({ $ref: Type.String() }, { $id: "ApiSchemaReference" });
export type ApiSchemaReference = Static<typeof ApiSchemaReference>;

export const ApiSchemaRoute = Type.Object({
  method: Type.String(),
  path: Type.String(),
  request: Type.Optional(ApiSchemaReference),
  response: ApiSchemaReference,
  events: Type.Optional(ApiSchemaReference),
}, { $id: "ApiSchemaRoute" });
export type ApiSchemaRoute = Static<typeof ApiSchemaRoute>;

export const ApiSchemaDocument = Type.Object({
  $schema: Type.Literal("https://json-schema.org/draft/2020-12/schema"),
  $defs: Type.Record(Type.String(), Type.Unknown()),
  "x-hui-api-version": Type.String(),
  "x-hui-areas": Type.Record(Type.String(), Type.Array(Type.String())),
  "x-hui-routes": Type.Array(ApiSchemaRoute),
}, { $id: "ApiSchemaDocument" });
export type ApiSchemaDocument = Static<typeof ApiSchemaDocument>;

export const ApiSchemaError = Type.Object({ error: Type.String() }, { $id: "ApiSchemaError" });
export type ApiSchemaError = Static<typeof ApiSchemaError>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/api-schema", response: ApiSchemaDocument },
];
