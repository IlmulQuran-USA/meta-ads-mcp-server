/**
 * meta-ads-mcp-server v3 — multi-portfolio (multi-token), multi-account,
 * built-in analysis engine, hardened. Read-only by design.
 *
 * Token env (choose ONE style):
 *   META_TOKENS='{"iqu":"EAAB...","deenova":"EAAB..."}'   several portfolios, alias -> token
 *   META_ACCESS_TOKEN=EAAB...                              single token (alias "default")
 *
 * Other env:
 *   META_DEFAULT_PORTFOLIO  alias used when a call omits portfolio (auto if only one)
 *   META_AD_ACCOUNT_IDS     optional global allowlist "111,222"
 *   META_DEFAULT_ACCOUNT    account used when a call omits account_id
 *   MCP_AUTH_TOKEN          Bearer secret for /mcp (header auth)
 *   MCP_PATH_SECRET         fallback: serve at /mcp/<secret> instead
 *   TRANSPORT=http|stdio  PORT=3000  META_API_VERSION=v21.0
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MetaClient, Paged } from "./meta.js";
import { analyze, InsightRow } from "./analysis.js";

// ---------------------------------------------------------------------------
// Config & security layer 1: environment validation
// ---------------------------------------------------------------------------

const CHARACTER_LIMIT = 40_000;

const portfolios = new Map<string, MetaClient>();
{
  const raw = process.env.META_TOKENS;
  if (raw) {
    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('META_TOKENS must be valid JSON like {"iqu":"EAAB...","other":"EAAB..."}');
      process.exit(1);
    }
    for (const [alias, token] of Object.entries(parsed)) {
      if (!/^[a-z0-9_-]{1,30}$/i.test(alias)) {
        console.error(`Portfolio alias '${alias}' invalid (use letters/digits/_/-, max 30).`);
        process.exit(1);
      }
      if (typeof token !== "string" || token.length < 20) {
        console.error(`Token for portfolio '${alias}' looks invalid.`);
        process.exit(1);
      }
      portfolios.set(alias, new MetaClient(token));
    }
  }
  if (process.env.META_ACCESS_TOKEN) {
    portfolios.set("default", new MetaClient(process.env.META_ACCESS_TOKEN));
  }
  if (portfolios.size === 0) {
    console.error("Provide META_TOKENS (JSON) or META_ACCESS_TOKEN.");
    process.exit(1);
  }
}
export const PORTFOLIO_ALIASES = [...portfolios.keys()];
const DEFAULT_PORTFOLIO =
  process.env.META_DEFAULT_PORTFOLIO && portfolios.has(process.env.META_DEFAULT_PORTFOLIO)
    ? process.env.META_DEFAULT_PORTFOLIO
    : portfolios.size === 1
      ? PORTFOLIO_ALIASES[0]
      : null;

const normalizeAcct = (id: string) => id.trim().replace(/^act_/, "");
const ALLOWLIST: Set<string> | null = process.env.META_AD_ACCOUNT_IDS
  ? new Set(process.env.META_AD_ACCOUNT_IDS.split(",").map(normalizeAcct).filter(Boolean))
  : null;
const DEFAULT_ACCOUNT = process.env.META_DEFAULT_ACCOUNT
  ? normalizeAcct(process.env.META_DEFAULT_ACCOUNT)
  : ALLOWLIST && ALLOWLIST.size === 1
    ? [...ALLOWLIST][0]
    : null;

/** Security layer 2: account IDs validated + allowlisted. */
function resolveAccount(accountId?: string): string {
  const id = accountId ? normalizeAcct(accountId) : DEFAULT_ACCOUNT;
  if (!id)
    throw new Error(
      "No account_id given and no default configured. Call meta_list_ad_accounts, then pass account_id."
    );
  if (!/^\d{5,20}$/.test(id)) throw new Error(`Invalid account_id format: '${id}' (expected numeric ID).`);
  if (ALLOWLIST && !ALLOWLIST.has(id))
    throw new Error(`Account ${id} is not in META_AD_ACCOUNT_IDS allowlist on this server.`);
  return id;
}

function assertObjectId(id: string, label: string): string {
  const clean = id.trim();
  if (!/^\d{5,25}$/.test(clean)) throw new Error(`Invalid ${label}: '${id}' (expected numeric ID).`);
  return clean;
}

// ---------------------------------------------------------------------------
// Portfolio routing: account -> portfolio auto-discovery (cached)
// ---------------------------------------------------------------------------

interface AcctInfo { account_id: string; name?: string; currency?: string; account_status?: number; amount_spent?: string }

const accountOwner = new Map<string, string>(); // account_id -> portfolio alias
let mapRefreshedAt = 0;
const MAP_TTL_MS = 10 * 60_000;

async function listAccounts(alias: string): Promise<AcctInfo[]> {
  const c = portfolios.get(alias)!;
  return c.getAllPages<AcctInfo>(
    "me/adaccounts",
    { fields: "account_id,name,currency,account_status,amount_spent", limit: 50 },
    3
  );
}

async function refreshAccountMap(): Promise<string[]> {
  const errors: string[] = [];
  for (const alias of PORTFOLIO_ALIASES) {
    try {
      for (const a of await listAccounts(alias)) {
        if (!accountOwner.has(String(a.account_id))) accountOwner.set(String(a.account_id), alias);
      }
    } catch (e) {
      errors.push(`[${alias}] ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  mapRefreshedAt = Date.now();
  return errors;
}

function portfolioParamCheck(alias: string): string {
  if (!portfolios.has(alias))
    throw new Error(`Unknown portfolio '${alias}'. Available: ${PORTFOLIO_ALIASES.join(", ")}.`);
  return alias;
}

/** Resolve which MetaClient should serve a call. */
async function clientFor(portfolio: string | undefined, accountId: string | undefined): Promise<{ client: MetaClient; alias: string }> {
  if (portfolio) {
    const alias = portfolioParamCheck(portfolio);
    return { client: portfolios.get(alias)!, alias };
  }
  if (portfolios.size === 1 || (DEFAULT_PORTFOLIO && !accountId)) {
    const alias = DEFAULT_PORTFOLIO ?? PORTFOLIO_ALIASES[0];
    return { client: portfolios.get(alias)!, alias };
  }
  if (accountId) {
    const id = normalizeAcct(accountId);
    if (Date.now() - mapRefreshedAt > MAP_TTL_MS) await refreshAccountMap();
    const alias = accountOwner.get(id);
    if (alias) return { client: portfolios.get(alias)!, alias };
    throw new Error(
      `Could not determine which portfolio owns account ${id}. Pass portfolio explicitly (one of: ${PORTFOLIO_ALIASES.join(", ")}).`
    );
  }
  throw new Error(
    `Multiple portfolios configured (${PORTFOLIO_ALIASES.join(", ")}) — pass 'portfolio' (or set META_DEFAULT_PORTFOLIO).`
  );
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n[Truncated at ${CHARACTER_LIMIT} chars — narrow with level/limit/lookback_days.]`
  );
}
const ok = (output: unknown) => ({
  content: [{ type: "text" as const, text: truncate(JSON.stringify(output, null, 2)) }],
});
const fail = (err: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true as const,
});

// ---------------------------------------------------------------------------
// Shared schemas / constants
// ---------------------------------------------------------------------------

const PortfolioParam = z
  .string()
  .optional()
  .describe(
    `Which token/portfolio to use. Available: ${PORTFOLIO_ALIASES.join(", ")}. Usually omit — the server auto-routes by account_id.`
  );

const AccountIdParam = z
  .string()
  .optional()
  .describe("Ad account ID (numeric, no 'act_'). Omit to use the server default.");

const EffectiveStatus = z
  .enum(["ACTIVE", "PAUSED", "ARCHIVED", "DELETED", "ALL"])
  .default("ALL")
  .describe("Filter by effective status ('ALL' = everything except deleted).");

const DatePreset = z.enum([
  "today", "yesterday", "last_3d", "last_7d", "last_14d", "last_28d",
  "last_30d", "last_90d", "this_month", "last_month", "maximum",
]);

const GoalAction = z
  .enum(["lead", "purchase", "contact", "complete_registration", "donate", "link_click"])
  .default("lead")
  .describe("Which conversion counts as a 'result'. For IQU enrollments use 'lead'.");

const INSIGHT_FIELDS = [
  "campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name",
  "spend", "impressions", "reach", "frequency", "clicks", "cpc", "cpm", "ctr",
  "actions", "cost_per_action_type", "date_start", "date_stop",
].join(",");

const statusFilter = (s: string) => (s === "ALL" ? undefined : JSON.stringify([s]));

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
function windowRange(lookbackDays: number, offsetWindows = 0): { since: string; until: string } {
  const until = new Date();
  until.setUTCDate(until.getUTCDate() - offsetWindows * lookbackDays);
  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - (lookbackDays - 1));
  return { since: fmtDate(since), until: fmtDate(until) };
}

// ---------------------------------------------------------------------------
// Server & tools
// ---------------------------------------------------------------------------

export const server = new McpServer({ name: "meta-ads-mcp-server", version: "3.0.0" });
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

server.registerTool(
  "meta_list_ad_accounts",
  {
    title: "List Ad Accounts (all portfolios)",
    description: `List every ad account across ALL configured portfolios/tokens (or one portfolio if specified). Call this FIRST, then pass account_id to other tools — the server auto-routes each account to the right portfolio token.

Returns JSON: { portfolios: { <alias>: { accounts: [{ account_id, name, currency, account_status (1=active, 2=disabled), amount_spent }] } }, errors?: string[] } — a portfolio whose token fails is reported in errors without blocking the others.`,
    inputSchema: { portfolio: PortfolioParam },
    annotations: RO,
  },
  async ({ portfolio }) => {
    try {
      const aliases = portfolio ? [portfolioParamCheck(portfolio)] : PORTFOLIO_ALIASES;
      const out: Record<string, { accounts: AcctInfo[] }> = {};
      const errors: string[] = [];
      for (const alias of aliases) {
        try {
          let accounts = await listAccounts(alias);
          if (ALLOWLIST) accounts = accounts.filter((a) => ALLOWLIST.has(String(a.account_id)));
          for (const a of accounts) {
            if (!accountOwner.has(String(a.account_id))) accountOwner.set(String(a.account_id), alias);
          }
          out[alias] = { accounts };
        } catch (e) {
          errors.push(`[${alias}] ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      mapRefreshedAt = Date.now();
      return ok({
        default_portfolio: DEFAULT_PORTFOLIO,
        default_account: DEFAULT_ACCOUNT,
        portfolios: out,
        ...(errors.length ? { errors } : {}),
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "meta_get_account_overview",
  {
    title: "Get Ad Account Overview",
    description: `Account name, currency, timezone, status and lifetime spend. Use to confirm connectivity and learn the currency for all spend figures.`,
    inputSchema: { account_id: AccountIdParam, portfolio: PortfolioParam },
    annotations: RO,
  },
  async ({ account_id, portfolio }) => {
    try {
      const acct = resolveAccount(account_id);
      const { client, alias } = await clientFor(portfolio, acct);
      const data = await client.get<Record<string, unknown>>(`act_${acct}`, {
        fields: "id,name,currency,timezone_name,account_status,amount_spent,spend_cap",
      });
      return ok({ portfolio: alias, ...data });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "meta_list_campaigns",
  {
    title: "List Campaigns",
    description: `List campaigns with objective, status, budgets (in the currency's minor units) and schedule.`,
    inputSchema: {
      account_id: AccountIdParam,
      portfolio: PortfolioParam,
      status: EffectiveStatus,
      limit: z.number().int().min(1).max(100).default(25),
    },
    annotations: RO,
  },
  async ({ account_id, portfolio, status, limit }) => {
    try {
      const acct = resolveAccount(account_id);
      const { client } = await clientFor(portfolio, acct);
      const data = await client.get<Paged<unknown>>(`act_${acct}/campaigns`, {
        fields:
          "id,name,objective,status,effective_status,daily_budget,lifetime_budget,created_time,start_time,stop_time",
        effective_status: statusFilter(status),
        limit,
      });
      return ok({ account_id: acct, count: data.data.length, campaigns: data.data });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "meta_list_adsets",
  {
    title: "List Ad Sets",
    description: `List ad sets (optionally inside one campaign) with budget, optimization goal and targeting spec.`,
    inputSchema: {
      account_id: AccountIdParam,
      portfolio: PortfolioParam,
      campaign_id: z.string().optional().describe("Restrict to one campaign"),
      status: EffectiveStatus,
      limit: z.number().int().min(1).max(100).default(25),
    },
    annotations: RO,
  },
  async ({ account_id, portfolio, campaign_id, status, limit }) => {
    try {
      const acct = campaign_id ? undefined : resolveAccount(account_id);
      const { client } = await clientFor(portfolio, acct ?? account_id);
      const parent = campaign_id ? assertObjectId(campaign_id, "campaign_id") : `act_${acct}`;
      const data = await client.get<Paged<unknown>>(`${parent}/adsets`, {
        fields:
          "id,name,campaign_id,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,targeting",
        effective_status: statusFilter(status),
        limit,
      });
      return ok({ count: data.data.length, adsets: data.data });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "meta_list_ads",
  {
    title: "List Ads",
    description: `List individual ads (optionally inside one campaign or ad set).`,
    inputSchema: {
      account_id: AccountIdParam,
      portfolio: PortfolioParam,
      parent_id: z.string().optional().describe("Campaign or ad set ID to filter by"),
      status: EffectiveStatus,
      limit: z.number().int().min(1).max(100).default(25),
    },
    annotations: RO,
  },
  async ({ account_id, portfolio, parent_id, status, limit }) => {
    try {
      const acct = parent_id ? undefined : resolveAccount(account_id);
      const { client } = await clientFor(portfolio, acct ?? account_id);
      const parent = parent_id ? assertObjectId(parent_id, "parent_id") : `act_${acct}`;
      const data = await client.get<Paged<unknown>>(`${parent}/ads`, {
        fields: "id,name,adset_id,campaign_id,effective_status,created_time,creative{id}",
        effective_status: statusFilter(status),
        limit,
      });
      return ok({ count: data.data.length, ads: data.data });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "meta_get_insights",
  {
    title: "Get Raw Performance Insights",
    description: `Raw metric rows (spend, impressions, reach, frequency, clicks, CPC, CPM, CTR, actions, cost_per_action_type) for an account, campaign, ad set or ad. Use meta_analyze_performance instead when the user wants verdicts/recommendations; use this for raw numbers, daily series, or demographic breakdowns.

In 'actions', look for action_type 'lead' for lead counts.`,
    inputSchema: {
      account_id: AccountIdParam,
      portfolio: PortfolioParam,
      object_id: z.string().optional().describe("Campaign/adset/ad ID; omit for whole account"),
      level: z.enum(["account", "campaign", "adset", "ad"]).default("campaign"),
      date_preset: DatePreset.default("last_30d"),
      time_increment: z.enum(["1", "7", "28"]).optional().describe("'1' = one row per day"),
      breakdown: z
        .enum(["age", "gender", "country", "region", "publisher_platform", "platform_position", "device_platform"])
        .optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
    annotations: RO,
  },
  async ({ account_id, portfolio, object_id, level, date_preset, time_increment, breakdown, limit }) => {
    try {
      const acct = object_id ? undefined : resolveAccount(account_id);
      const { client } = await clientFor(portfolio, acct ?? account_id);
      const parent = object_id ? assertObjectId(object_id, "object_id") : `act_${acct}`;
      const data = await client.get<Paged<unknown>>(`${parent}/insights`, {
        fields: INSIGHT_FIELDS,
        level,
        date_preset,
        time_increment,
        breakdowns: breakdown,
        limit,
      });
      return ok({
        count: data.data.length,
        rows: data.data,
        ...(data.data.length === 0
          ? { note: `No delivery for ${parent} in ${date_preset}. Try last_90d or maximum.` }
          : {}),
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "meta_analyze_performance",
  {
    title: "Analyze Performance (verdicts & recommendations)",
    description: `The main analysis tool. Pulls the current window AND the previous window of insights, computes cost-per-result, compares every campaign/adset/ad against the account median, and classifies each as:

  LOSING            — meaningful spend, zero results, or cost/result >2x median → pause
  UNDERPERFORMING   — cost/result >1.3x median → watch closely
  FATIGUED          — frequency >3.5 or CTR fell >30% vs previous window → refresh creative
  SCALE_CANDIDATE   — cost/result ≤0.7x median with volume & healthy frequency → raise budget 20-30%
  HEALTHY / INSUFFICIENT_DATA

Returns JSON: { portfolio, account_id, goal_action, window, totals { spend, results, blended_cost_per_result, median_cost_per_result }, summary: string[], entities: [{ id, name, spend, results, cost_per_result, ctr, cpm, frequency, verdict, reasons[], recommendation, trend }] }

The server only reads data — pausing/scaling is always the human's decision.

Examples:
  - "কোন ক্যাম্পেইনে লস করছি?" -> level=campaign, lookback_days=7
  - "Which ads should I scale this month?" -> level=ad, lookback_days=30`,
    inputSchema: {
      account_id: AccountIdParam,
      portfolio: PortfolioParam,
      level: z.enum(["campaign", "adset", "ad"]).default("adset"),
      goal_action: GoalAction,
      lookback_days: z.number().int().min(3).max(90).default(7),
      min_spend: z.number().min(0).max(100000).default(5),
    },
    annotations: RO,
  },
  async ({ account_id, portfolio, level, goal_action, lookback_days, min_spend }) => {
    try {
      const acct = resolveAccount(account_id);
      const { client, alias } = await clientFor(portfolio, acct);
      const [acctInfo, curr, prev] = await Promise.all([
        client.get<{ currency?: string }>(`act_${acct}`, { fields: "currency" }),
        client.getAllPages<InsightRow>(`act_${acct}/insights`, {
          fields: INSIGHT_FIELDS,
          level,
          time_range: JSON.stringify(windowRange(lookback_days, 0)),
          limit: 200,
        }),
        client.getAllPages<InsightRow>(`act_${acct}/insights`, {
          fields: INSIGHT_FIELDS,
          level,
          time_range: JSON.stringify(windowRange(lookback_days, 1)),
          limit: 200,
        }),
      ]);

      const w = windowRange(lookback_days, 0);
      const result = analyze(curr, prev, {
        goal_action,
        level,
        window: `${w.since} → ${w.until} (${lookback_days}d, vs previous ${lookback_days}d)`,
        min_spend,
        currency: acctInfo.currency ?? "USD",
      });
      return ok({ portfolio: alias, account_id: acct, ...result });
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Transport layers live in their own entry points:
//   src/node-entry.ts   -> stdio + express (local dev, VPS, Railway-style hosts)
//   src/worker.ts       -> Cloudflare Workers (stateless JSON-RPC over HTTP)
// ---------------------------------------------------------------------------
