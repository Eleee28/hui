/**
 * `/__hui/providers…`: the model providers' snapshot, their logins (start, answer a prompt, cancel), accounts
 * (order, remove, quota) and saved models, over `providers.ts`. `hui.ts` applies the `x-hui` guard before
 * dispatching here.
 */
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import { ProviderError, ProviderLogin, ProviderOk, ProviderQuota, ProviderSnapshot } from "../api/providers.ts";
export { routeSchemas } from "../api/providers.ts";
import { ProviderInputError, type ProviderService } from "../pi/providers.ts";

const PROVIDERS_ROUTE = "/__hui/providers";

export function createProviderRoutes(deps: { providerService: ProviderService }) {
  async function handle(request: RouteRequest): Promise<JsonResult | undefined> {
    const { method, path } = request;
    if (path !== PROVIDERS_ROUTE && !path.startsWith(`${PROVIDERS_ROUTE}/`)) return undefined;
    const { providerService } = deps;
    try {
      const parts = path.slice(PROVIDERS_ROUTE.length).split("/").filter(Boolean);
      const [id, action] = parts;
      if (!id && method === "GET") return reply(ProviderSnapshot, await providerService.snapshot());
      if (id === "login" && action && parts.length === 2 && method === "DELETE") {
        providerService.cancel(action); return reply(ProviderOk, { ok: true });
      }
      if (id === "login" && action && parts.length === 2 && method === "POST") {
        const body = await request.json() as Record<string, unknown>;
        providerService.answer(action, body["promptId"], body["value"]); return reply(ProviderOk, { ok: true });
      }
      if (id && action === "login" && parts.length === 2 && method === "POST") {
        const body = await request.json() as Record<string, unknown>;
        return reply(ProviderLogin, await providerService.start(id, body["method"], { accountId: body["accountId"], name: body["name"] }));
      }
      if (id && action === "accounts" && parts.length === 2 && method === "PUT") {
        const body = await request.json() as Record<string, unknown>;
        await providerService.reorder(id, body["order"]); return reply(ProviderOk, { ok: true });
      }
      if (id && action === "accounts" && parts[2] && parts.length === 3 && method === "DELETE") {
        await providerService.removeAccount(id, parts[2]); return reply(ProviderOk, { ok: true });
      }
      if (id && action === "accounts" && parts[2] && parts[3] === "quota" && parts.length === 4 && method === "GET") {
        return reply(ProviderQuota, await providerService.quota(id, parts[2]));
      }
      if (id && action === "quota" && parts.length === 2 && method === "GET") return reply(ProviderQuota, await providerService.quota(id));
      if (id && !action && method === "PUT") {
        const body = await request.json() as Record<string, unknown>;
        await providerService.save(id, body["models"]); return reply(ProviderOk, { ok: true });
      }
      if (id && !action && method === "DELETE") {
        await providerService.disconnect(id); return reply(ProviderOk, { ok: true });
      }
      return reply(ProviderError, { error: "method not allowed" }, 405);
    } catch (error) {
      return reply(ProviderError,
        { error: error instanceof ProviderInputError ? error.message : "Provider operation failed. Check the gateway and retry." },
        error instanceof ProviderInputError ? 400 : 500);
    }
  }

  return { handle };
}
