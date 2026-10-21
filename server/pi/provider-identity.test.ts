import assert from "node:assert/strict";
import { test } from "vitest";
import { credentialEmail, providerEmail } from "./provider-identity.ts";
const jwt = (claims: unknown) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
test("Codex identity exposes only display email from OAuth claims, never API keys", () => {
  const access = jwt({ "https://api.openai.com/profile": { email: "Alex+work@example.com" }, secret: "private" });
  assert.equal(credentialEmail("openai-codex", { type: "oauth", access }), "Alex+work@example.com");
  assert.equal(credentialEmail("openai-codex", { type: "oauth", id_token: jwt({ email: "id@example.com" }), access }), "id@example.com");
  assert.equal(credentialEmail("anthropic", { type: "oauth", access }), undefined);
  assert.equal(credentialEmail("openai-codex", { type: "api_key", access }), undefined);
  for (const access of ["opaque", "a.not_json.c", "a.@@.c", jwt(null), jwt({ email: "bad\n@example.com" }), "a." + "e".repeat(64000) + ".c"]) {
    assert.equal(credentialEmail("openai-codex", { type: "oauth", access }), undefined);
  }
  for (const value of [undefined, "<script>@example.com", "a\u202E@example.com", "no-email", "a@" + "b".repeat(255) + ".com"]) assert.equal(providerEmail(value), undefined);
});
