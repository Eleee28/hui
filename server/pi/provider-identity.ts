/** Display-only identity. Never use token claims to authorize or merge accounts. */
export function providerEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim();
  return email.length <= 254 && /^[^\s<>@\p{C}]+@[^\s<>@\p{C}]+\.[^\s<>@\p{C}]+$/u.test(email) ? email : undefined;
}
export function credentialEmail(provider: string, credential: unknown): string | undefined {
  if (provider !== "openai-codex" || !credential || typeof credential !== "object") return undefined;
  const data = credential as Record<string, unknown>;
  if (data["type"] !== "oauth") return undefined;
  for (const token of [data["id_token"], data["idToken"], data["access"]]) {
    if (typeof token !== "string" || token.length > 64_000) continue;
    const parts = token.split(".");
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1]!)) continue;
    try {
      const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
      const email = providerEmail(claims?.["https://api.openai.com/profile"]?.email) ?? providerEmail(claims?.email);
      if (email) return email;
    } catch { /* Opaque or malformed tokens have no display identity. */ }
  }
  return undefined;
}
