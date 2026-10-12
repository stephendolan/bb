import { type BbPluginApi } from "@get-bb/plugin-sdk";
import type { AccountSummary } from "./contracts.js";
import type { AccountPoolHub } from "./hub.js";
import {
  usageSourceRpcContract,
  usageListMethod,
  usageFetchMethod,
  type UsageMeasurement,
} from "./usage-contract.js";

type UsageWindow = Extract<
  UsageMeasurement["usage"],
  { status: "ok" }
>["windows"][number];

export function usageWindowLabel(
  minutes: number | null,
  fallback: string,
): string {
  if (minutes === 300) return "Five-hour limit";
  if (minutes === 1_440) return "Daily limit";
  if (minutes === 10_080) return "Weekly limit";
  if (minutes === null) return fallback;
  return minutes % 1_440 === 0
    ? `${minutes / 1_440} day limit`
    : `${minutes / 60} hour limit`;
}

export function usagePlanLabel(
  account: Pick<AccountSummary, "subscriptionType" | "rateLimitTier">,
): string | null {
  const maxMatch = (account.rateLimitTier ?? "").match(/max_(\d+)x/u);
  if (maxMatch) return `Max (${maxMatch[1]}x)`;
  const subscription = account.subscriptionType;
  return subscription
    ? subscription.charAt(0).toUpperCase() + subscription.slice(1)
    : null;
}

function accountKey(account: AccountSummary): string | null {
  return account.provider === "codex"
    ? account.codexAccountId
      ? `openai:chatgpt:${account.codexAccountId}`
      : null
    : account.accountUuid
      ? `anthropic:account:${account.accountUuid}`
      : null;
}

export function usageAccounts(
  accounts: readonly AccountSummary[],
): AccountSummary[] {
  const enabled = accounts.filter((account) => account.enabled);
  const representatives = new Map<string, AccountSummary>();
  for (const account of enabled) {
    const key = accountKey(account);
    if (key === null) continue;
    const current = representatives.get(key);
    if (current === undefined || reportsUsageBetter(account, current))
      representatives.set(key, account);
  }
  return enabled.filter((account) => {
    const key = accountKey(account);
    return key === null || representatives.get(key) === account;
  });
}

function reportsUsageBetter(
  candidate: AccountSummary,
  current: AccountSummary,
): boolean {
  if ((candidate.error === null) !== (current.error === null))
    return candidate.error === null;
  return (candidate.observedAt ?? -1) > (current.observedAt ?? -1);
}

function usageWindows(account: AccountSummary): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const add = (
    id: string,
    label: string,
    utilization: number | null,
    reset: number | null,
    model: string | null,
  ) => {
    if (utilization === null) return;
    windows.push({
      kind:
        label === "Five-hour limit"
          ? "five-hour"
          : label === "Daily limit"
            ? "daily"
            : label.startsWith("Weekly")
              ? "weekly"
              : "custom",
      id,
      label,
      usedPercent: Math.round(utilization * 100),
      resetsAt: reset === null ? null : new Date(reset).toISOString(),
      model,
      cost: null,
    });
  };
  if (account.limitWindows.length > 0) {
    for (const window of account.limitWindows) {
      add(
        window.slot,
        usageWindowLabel(window.windowMinutes, window.slot),
        window.utilization,
        window.resetAt,
        null,
      );
    }
  } else {
    add(
      "five-hour",
      "Five-hour limit",
      account.fiveHourUtilization,
      account.fiveHourResetAt,
      null,
    );
    add(
      "weekly",
      "Weekly limit",
      account.sevenDayUtilization,
      account.sevenDayResetAt,
      null,
    );
  }
  for (const [family, window] of Object.entries(account.familyWeekly)) {
    if (window !== null)
      add(
        `weekly:${family}`,
        `Weekly · ${family}`,
        window.utilization,
        window.resetAt,
        family,
      );
  }
  return windows;
}

export function usageMeasurement(account: AccountSummary): UsageMeasurement {
  const accountFields = {
    plan: account.subscriptionType
      ? {
          id: account.subscriptionType.toLowerCase(),
          multiplier:
            Number(account.rateLimitTier?.match(/max_(\d+)x/u)?.[1]) || null,
        }
      : null,
    accountEmail: account.email,
    planLabel: usagePlanLabel(account),
  };
  const measurement = {
    accountKey: accountKey(account),
    observedAt: account.observedAt,
  };
  if (account.error !== null)
    return {
      ...measurement,
      usage: {
        status: account.kind === "oauth" ? "expired" : "unauthenticated",
        ...accountFields,
      },
    };
  if (account.kind === "oauth" && account.observedAt === null)
    return {
      ...measurement,
      usage: {
        status: "error",
        ...accountFields,
        message: "Usage has not been observed for this account.",
      },
    };
  return {
    ...measurement,
    usage: { status: "ok", ...accountFields, windows: usageWindows(account) },
  };
}

export function registerUsageSource(bb: BbPluginApi, hub: AccountPoolHub) {
  const enabledAccount = async (
    resourceId: string,
  ): Promise<AccountSummary> => {
    const account = (await hub.status()).accounts.find(
      (candidate) => candidate.id === resourceId,
    );
    if (account === undefined || !account.enabled)
      throw new Error("Usage resource no longer exists.");
    return account;
  };
  bb.rpc.register(
    usageSourceRpcContract,
    {
      async [usageListMethod]() {
        const { accounts } = await hub.status();
        return {
          label: "Account Pooler",
          resources: usageAccounts(accounts).map((account) => ({
            id: account.id,
            accountKey: accountKey(account),
            providerId: account.provider === "claude" ? "claude-code" : "codex",
            label:
              account.email ??
              (account.provider === "claude" ? "Claude Code" : "Codex"),
            scope: { kind: "shared" as const },
          })),
        };
      },
      async [usageFetchMethod]({ resourceId, refresh }) {
        await enabledAccount(resourceId);
        await hub.refreshUsage(resourceId, refresh);
        return usageMeasurement(await enabledAccount(resourceId));
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Usage windows for Account Pooler's shared accounts, independent of routing settings and host-local credentials.",
    },
  );
}
