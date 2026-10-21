/** Synthetic upstream payloads, consumed by the real parser in the test-only server. */
export function quotaFixture(provider, account, now = Date.now()) {
  const reset = (hours) => Math.floor((now + hours * 3600000) / 1000);
  if (provider === "openai-codex") {
    const exhausted = account !== "default";
    return { plan_type: exhausted ? "pro" : "plus", rate_limit: {
      allowed: !exhausted, limit_reached: exhausted,
      primary_window: { used_percent: exhausted ? 100 : 34, limit_window_seconds: 18000, reset_at: reset(3) },
      secondary_window: { used_percent: 62, limit_window_seconds: 604800, reset_at: reset(96) },
    }, individual_limit: { limit: 1000, used: 180, reset_at: reset(240) },
    code_review_rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 604800, reset_at: reset(96) } },
    additional_rate_limits: [{ limit_name: "Spark", rate_limit: { primary_window: { used_percent: 8, limit_window_seconds: 18000, reset_at: reset(3) } } }],
    };
  }
  if (provider === "anthropic") return {
    five_hour: { utilization: 28, resets_at: new Date(now + 7200000).toISOString() },
    seven_day: { utilization: 54, resets_at: new Date(now + 345600000).toISOString() },
    seven_day_sonnet: { utilization: 100 },
    extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 2100 },
  };
  if (provider === "opencode-go") return { usage: {
    rolling: { percent: 0.5, resetsAt: new Date(now + 7200000).toISOString() },
    weekly: { percent: 32, resetsAt: new Date(now + 345600000).toISOString() },
    monthly: { percent: 68, resetsAt: new Date(now + 864000000).toISOString() },
  } };
  return {};
}
