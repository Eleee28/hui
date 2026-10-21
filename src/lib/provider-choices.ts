/**
 * How model providers are grouped and named in the connection UI: the featured brands, their display names
 * and the sign-in methods each offers. PI owns the providers and credentials themselves.
 */
import type { ProviderSummary } from "../api/schema/providers.ts";

export const providerBrands = [
  { id: "opencode-go", name: "OpenCode Go", description: "Use your OpenCode Go subscription.", providers: ["opencode-go"] },
  { id: "openai", name: "OpenAI", description: "ChatGPT account or API key.", providers: ["openai-codex", "openai"] },
  { id: "anthropic", name: "Claude", description: "Claude account or API key.", providers: ["anthropic"] },
] as const;

export function providerBrand(id: string) {
  return providerBrands.find((brand) => (brand.providers as readonly string[]).includes(id));
}

export function connectionName(provider: ProviderSummary): string {
  if (provider.id === "openai-codex") return "OpenAI · ChatGPT account";
  if (provider.id === "openai") return "OpenAI · API key";
  if (provider.id === "anthropic") return "Claude";
  return provider.name;
}

type ConnectionMethod = { provider: ProviderSummary; method: "api_key" | "oauth"; label: string; description: string };

export function connectionMethods(brand: string, providers: ProviderSummary[]): ConnectionMethod[] {
  const definition = providerBrands.find((entry) => entry.id === brand);
  const ids: readonly string[] = definition?.providers ?? providers.filter((entry) => entry.id === brand && entry.configured).map((entry) => entry.id);
  return ids.flatMap<ConnectionMethod>((id) => {
    const provider = providers.find((entry) => entry.id === id);
    if (!provider) return [];
    return provider.methods.map((method) => ({ provider, method: method.id,
      label: method.id === "api_key" ? "API key" : id === "openai-codex" ? "ChatGPT account" : id === "anthropic" ? "Claude Pro / Max" : method.label,
      description: method.id === "api_key" ? "Enter a key saved securely by HUI." : "Sign in with your subscription.",
    }));
  });
}
