import assert from "node:assert/strict";
import { test } from "vitest";
import { fetchProviderQuota, parseProviderQuota } from "./provider-quota.ts";

test("quota parsing keeps zero, finite measured windows and exact reset times", () => {
  const claude = parseProviderQuota("anthropic", { five_hour: { utilization: 0, resets_at: "2026-09-27T17:00:00Z" }, seven_day: { utilization: 63 }, seven_day_opus: { utilization: null } }, 123);
  assert.equal(claude.checkedAt, 123); assert.equal(claude.status, "available");
  assert.deepEqual(claude.windows, [{ label: "5 hours", usedPercent: 0, scope: "account", resetAt: Date.parse("2026-09-27T17:00:00Z") }, { label: "Weekly", usedPercent: 63, scope: "account" }]);
  const codex = parseProviderQuota("openai-codex", { rate_limit: { primary_window: { used_percent: 28, limit_window_seconds: 18000, reset_at: 1000 }, secondary_window: { used_percent: 82, limit_window_seconds: 604800 } } });
  assert.deepEqual(codex.windows, [{ label: "5 hours", usedPercent: 28, scope: "account", resetAt: 1_000_000 }, { label: "Weekly", usedPercent: 82, scope: "account" }]);
  for (const invalid of [undefined, null, "42", -1, NaN, Infinity]) {
    assert.equal(parseProviderQuota("anthropic", { five_hour: { utilization: invalid } }).status, "unavailable");
  }
});

test("quota fetch uses fixed origin and hides upstream errors and credentials", async () => {
  const fetcher = (async (url, init) => {
    assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(init?.redirect, "error");
    assert.equal((init?.headers as Record<string, string>)["ChatGPT-Account-Id"], "fixture-account");
    return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 12 } } }));
  }) as typeof fetch;
  assert.equal((await fetchProviderQuota("openai-codex", "private-token", "fixture-account", fetcher)).status, "available");
  const failed = await fetchProviderQuota("anthropic", "private-token", undefined, (async () => new Response("private-token", { status: 401 })) as typeof fetch);
  assert.equal(failed.status, "unavailable"); assert(!JSON.stringify(failed).includes("private-token"));
  const huge = await fetchProviderQuota("anthropic", "private-token", undefined, (async () => new Response("x".repeat(128001))) as typeof fetch);
  assert.equal(huge.status, "unavailable");
  const unsupported = await fetchProviderQuota("opencode", "private-token", undefined, (async () => { throw new Error("must not fetch"); }) as typeof fetch);
  assert.equal(unsupported.status, "unsupported");
});


test("Claude retains every reported period, scoped limits and monthly extra usage", () => {
  const quota = parseProviderQuota("anthropic", {
    five_hour: { utilization: 12 }, seven_day: { utilization: 24 },
    seven_day_sonnet: { utilization: 100 }, seven_day_oauth_apps: { utilization: 45 },
    monthly: { utilization: 66 }, seven_day_future_model: { utilization: 73 },
    limits: [{ group: "weekly", percent: 81, scope: { model: { display_name: "Fable" } } }, { percent: 20, is_active: false }],
    extra_usage: { is_enabled: true, used_credits: 250, monthly_limit: 1000 },
  });
  assert.deepEqual(quota.windows.map(w => [w.label, w.usedPercent, w.scope]), [
    ["5 hours", 12, "account"], ["Weekly", 24, "account"], ["Sonnet weekly", 100, "scoped"],
    ["OAuth apps weekly", 45, "scoped"], ["Monthly", 66, "account"],
    ["seven day future model", 73, "scoped"], ["Fable · weekly", 81, "scoped"], ["Monthly extra usage", 25, "spend"],
  ]);
  assert.equal(quota.access, undefined, "Scoped exhaustion does not imply account exhaustion or billing state");
  assert.equal(quota.plan, undefined);
});

test("Codex includes plan, all rate windows, scoped reviews/models and monthly credit budget", () => {
  const quota = parseProviderQuota("openai-codex", {
    plan_type: "plus", rate_limit: { allowed: true,
      primary_window: { used_percent: 12, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 24, limit_window_seconds: 604800 },
      monthly_window: { used_percent: 33, limit_window_seconds: 2592000 },
    },
    code_review_rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 604800 } },
    additional_rate_limits: [{ limit_name: "Spark", rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18000 } } }],
    spend_control: { individual_limit: { remaining_percent: 60, reset_at: 2000 } },
  }, 100);
  assert.equal(quota.plan, "plus"); assert.equal(quota.access, "available");
  assert.deepEqual(quota.windows.map(w => w.label), ["5 hours", "Weekly", "30 days", "Code review · Weekly", "Spark · 5 hours", "Monthly credits"]);
  assert.deepEqual(quota.windows.at(-1), { label: "Monthly credits", usedPercent: 40, resetAt: 2000000, scope: "spend" });
  assert.equal(quota.windows.filter(w => w.scope === "account").length, 3);
});

test("Missing or malformed periods never invent zero usage, subscription state or dates", () => {
  const quota = parseProviderQuota("openai-codex", { plan_type: "<private-token>", rate_limit: { primary_window: { used_percent: 0, reset_at: -1 }, secondary_window: { used_percent: "50" } } });
  assert.equal(quota.plan, undefined); assert.equal(quota.access, undefined);
  assert.deepEqual(quota.windows, [{ label: "primary window", usedPercent: 0, scope: "account" }]);
  assert.match(quota.message!, /Some reported limits/);
  const onlyPlan = parseProviderQuota("openai-codex", { plan_type: "pro" });
  assert.equal(onlyPlan.plan, "pro"); assert.equal(onlyPlan.status, "unavailable");
  assert.equal(onlyPlan.access, undefined);
  assert.equal(parseProviderQuota("anthropic", { extra_usage: { is_enabled: true, monthly_limit: 0, used_credits: 5 } }).windows.length, 0);
  assert.match(parseProviderQuota("anthropic", { extra_usage: { is_enabled: false } }).message!, /disabled/);
});

test("Over-limit measurements remain truthful; elapsed windows do not create a new cooldown", () => {
  const over = parseProviderQuota("anthropic", { five_hour: { utilization: 105, resets_at: 10 } }, 1000);
  assert.equal(over.windows[0]?.usedPercent, 105); assert.equal(over.access, "limited");
  const expired = parseProviderQuota("anthropic", { five_hour: { utilization: 100, resets_at: 1 } }, 2000);
  assert.equal(expired.access, undefined);
  const blocked = parseProviderQuota("openai-codex", { rate_limit: { allowed: false } });
  assert.equal(blocked.access, "limited"); assert.equal(blocked.status, "unavailable");
});

test("OpenCode Go preserves percentage units and all three reset windows", async () => {
  const quota = await fetchProviderQuota("opencode-go", "synthetic-go-key", undefined, (async (url, init) => {
    assert.equal(url, "https://opencode.ai/zen/go/v1/usage");
    assert.equal(init?.redirect, "error");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer synthetic-go-key");
    return new Response(JSON.stringify({ usage: {
      rolling: { percent: 0.5, resetsAt: "2030-01-01T01:00:00Z" },
      weekly: { percent: 0, resetsAt: "2030-01-02T01:00:00Z" },
      monthly: { percent: 100, resetsAt: "2030-02-01T01:00:00Z" },
    } }));
  }) as typeof fetch);
  assert.deepEqual(quota.windows.map((w) => [w.label, w.usedPercent]), [["5 hours", 0.5], ["Weekly", 0], ["Monthly", 100]]);
  assert.equal(quota.windows[0]?.resetAt, Date.parse("2030-01-01T01:00:00Z"));
  assert.equal(quota.access, "limited");
  assert.equal(quota.email, undefined);
  const partial = parseProviderQuota("opencode-go", { usage: { rolling: { percent: 42 }, weekly: { percent: "bad" } } });
  assert.equal(partial.windows.length, 1); assert.match(partial.message!, /Some reported limits/);
  for (const status of [401, 403, 500]) {
    const failed = await fetchProviderQuota("opencode-go", "synthetic-go-key", undefined, (async () => new Response("private upstream details", { status })) as typeof fetch);
    assert.equal(failed.status, "unavailable"); assert(!JSON.stringify(failed).includes("private upstream"));
  }
});

test("Claude profile and usage fail independently and never expose profile secrets", async () => {
  for (const fail of ["none", "profile", "usage"]) {
    const quota = await fetchProviderQuota("anthropic", "synthetic-token", undefined, (async (url, init) => {
      assert.equal(init?.redirect, "error");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer synthetic-token");
      const endpoint = String(url).endsWith("/profile") ? "profile" : "usage";
      assert.equal(String(url), `https://api.anthropic.com/api/oauth/${endpoint}`);
      if (endpoint === fail) return new Response("private", { status: 403 });
      return new Response(JSON.stringify(endpoint === "profile" ? { account: { email_address: "claude@example.com", secret: "private" } } : { five_hour: { utilization: 42 } }));
    }) as typeof fetch);
    assert.equal(quota.email, fail === "profile" ? undefined : "claude@example.com");
    assert.equal(quota.status, fail === "usage" ? "unavailable" : "available");
    assert(!JSON.stringify(quota).includes("private"));
  }
});
