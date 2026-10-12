import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  accountSummarySchema,
  EMPTY_FAMILY_WEEKLY,
  type AccountSummary,
} from "./contracts.js";
import {
  usageAccounts,
  usageMeasurement,
  usagePlanLabel,
  usageWindowLabel,
} from "./usage-source.js";

const CLAUDE_ACCOUNT = "02b2dd90-bd88-4eaa-a84f-93693c605392";
const REJECTED = "OAuth refresh failed with HTTP 400.";

function summary(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return accountSummarySchema.parse({
    id: randomUUID(),
    provider: "claude",
    kind: "oauth",
    label: "pool@example.com",
    email: "pool@example.com",
    accountUuid: CLAUDE_ACCOUNT,
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
    enabled: true,
    priority: 1,
    createdAt: 1,
    lastUsedHostName: null,
    usageRestriction: null,
    extraUsage: null,
    fiveHourUtilization: 0.104,
    fiveHourResetAt: Date.UTC(2026, 9, 12, 18),
    fiveHourStatus: "allowed",
    sevenDayUtilization: 0.28,
    sevenDayResetAt: Date.UTC(2026, 9, 18, 12),
    sevenDayStatus: "allowed",
    representativeClaim: "five_hour",
    familyWeekly: EMPTY_FAMILY_WEEKLY,
    limitWindows: [],
    observedAt: 1_000,
    heldUntil: null,
    error: null,
    inFlight: 0,
    status: "ready",
    ...overrides,
  });
}

describe("usage presentation labels", () => {
  it("names known windows consistently and retains other durations", () => {
    expect(usageWindowLabel(10_080, "primary")).toBe("Weekly limit");
    expect(usageWindowLabel(300, "secondary")).toBe("Five-hour limit");
    expect(usageWindowLabel(1_440, "primary")).toBe("Daily limit");
    expect(usageWindowLabel(2_880, "primary")).toBe("2 day limit");
    expect(usageWindowLabel(null, "Custom limit")).toBe("Custom limit");
  });
  it("retains known Max multipliers without inventing a missing tier", () => {
    expect(
      usagePlanLabel({
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      }),
    ).toBe("Max (20x)");
    expect(
      usagePlanLabel({ subscriptionType: "max", rateLimitTier: null }),
    ).toBe("Max");
    expect(
      usagePlanLabel({ subscriptionType: "pro", rateLimitTier: null }),
    ).toBe("Pro");
    expect(
      usagePlanLabel({ subscriptionType: null, rateLimitTier: null }),
    ).toBeNull();
  });
});

describe("usage inventory", () => {
  it("keeps disabled and rejected logins of a subscription from hiding its working login", () => {
    const retired = summary({
      enabled: false,
      error: REJECTED,
      status: "disabled",
    });
    const rejected = summary({
      error: REJECTED,
      observedAt: 3_000,
      status: "error",
    });
    const earlier = summary({ observedAt: 1_000 });
    const working = summary({ observedAt: 2_000 });

    expect(
      usageAccounts([retired, rejected, earlier, working]).map(
        (account) => account.id,
      ),
    ).toEqual([working.id]);
    expect(
      usageAccounts([retired, rejected]).map((account) => account.id),
    ).toEqual([rejected.id]);
  });

  it("keeps pool order and never merges accounts without a provider identity", () => {
    const codex = summary({
      provider: "codex",
      accountUuid: null,
      codexAccountId: "chatgpt-account",
      rateLimitTier: null,
      subscriptionType: "pro",
    });
    const claude = summary();
    const firstKey = summary({ kind: "api-key", accountUuid: null });
    const secondKey = summary({ kind: "api-key", accountUuid: null });

    expect(
      usageAccounts([codex, claude, firstKey, secondKey]).map(
        (account) => account.id,
      ),
    ).toEqual([codex.id, claude.id, firstKey.id, secondKey.id]);
  });
});

describe("usage measurement", () => {
  it("reports measured windows for a working subscription", () => {
    expect(usageMeasurement(summary())).toEqual({
      accountKey: `anthropic:account:${CLAUDE_ACCOUNT}`,
      observedAt: 1_000,
      usage: {
        status: "ok",
        plan: { id: "max", multiplier: 20 },
        accountEmail: "pool@example.com",
        planLabel: "Max (20x)",
        windows: [
          {
            kind: "five-hour",
            id: "five-hour",
            label: "Five-hour limit",
            usedPercent: 10,
            resetsAt: "2026-10-12T18:00:00.000Z",
            model: null,
            cost: null,
          },
          {
            kind: "weekly",
            id: "weekly",
            label: "Weekly limit",
            usedPercent: 28,
            resetsAt: "2026-10-18T12:00:00.000Z",
            model: null,
            cost: null,
          },
        ],
      },
    });
  });

  it("asks for a new sign-in instead of reporting a failed refresh for rejected credentials", () => {
    expect(
      usageMeasurement(summary({ error: REJECTED, status: "error" })),
    ).toEqual({
      accountKey: `anthropic:account:${CLAUDE_ACCOUNT}`,
      observedAt: 1_000,
      usage: {
        status: "expired",
        plan: { id: "max", multiplier: 20 },
        accountEmail: "pool@example.com",
        planLabel: "Max (20x)",
      },
    });
    expect(
      usageMeasurement(
        summary({
          kind: "api-key",
          accountUuid: null,
          error: "Anthropic returned HTTP 401.",
          status: "error",
        }),
      ).usage.status,
    ).toBe("unauthenticated");
  });

  it("reports an unobserved subscription as uncollected without inventing utilization", () => {
    expect(usageMeasurement(summary({ observedAt: null })).usage).toEqual({
      status: "error",
      plan: { id: "max", multiplier: 20 },
      accountEmail: "pool@example.com",
      planLabel: "Max (20x)",
      message: "Usage has not been observed for this account.",
    });
  });

  it("reports an API key as having no usage limits rather than failing to refresh", () => {
    expect(
      usageMeasurement(
        summary({
          kind: "api-key",
          accountUuid: null,
          email: null,
          subscriptionType: null,
          rateLimitTier: null,
          fiveHourUtilization: null,
          fiveHourResetAt: null,
          fiveHourStatus: null,
          sevenDayUtilization: null,
          sevenDayResetAt: null,
          sevenDayStatus: null,
          representativeClaim: null,
          observedAt: null,
        }),
      ),
    ).toEqual({
      accountKey: null,
      observedAt: null,
      usage: {
        status: "ok",
        plan: null,
        accountEmail: null,
        planLabel: null,
        windows: [],
      },
    });
  });
});
