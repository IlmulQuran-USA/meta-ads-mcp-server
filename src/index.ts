/**
 * meta-ads-mcp-server v2 — multi-account, analysis engine, hardened.
 *
 * Env:
 *   META_ACCESS_TOKEN     (required)  token with ads_read
 *   META_AD_ACCOUNT_IDS   (optional)  comma-separated allowlist, e.g. "111,222".
 *                                     If unset, every account the token can see is queryable.
 *   META_DEFAULT_ACCOUNT  (optional)  account used when a tool call omits account_id
 *   MCP_AUTH_TOKEN        (recommended) Bearer token required on /mcp
 *   TRANSPORT=http|stdio  PORT=3000   META_API_VERSION=v21.0
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import { z } from "zod";
import { MetaClient, Paged } from "./meta.js";
import { analyze, InsightRow } from "./analysis.js";

// ---------------------------------------------------------------------------
// Config & security layer 1: environment validation
// ---------------------------------------------------------------------------

const CHARACTER_LIMIT = 40_000;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const client = new MetaClient(requireEnv("META_ACCESS_TOKEN"));

const normalizeAcct = (id: string) => id.trim().replace(/^act_/, "");
const ALLOWLIST: Set<string> | null = process.env.META_AD_ACCOUNT_IDS
  ? new Set(process.env.META_AD_ACCOUNT_IDS.split(",").map(normalizeAcct).filter(Boolean))
  : null;
const DEFAULT_ACCOUNT = process.env.META_DEFAULT_ACCOUNT
  ? normalizeAcct(process.env.META_DEFAULT_ACCOUNT)
  : ALLOWLIST && ALLOWLIST.size === 1
    ? [...ALLOWLIST][0]
    : null;

/** Security layer 2: every account_id passes through here. */
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

/** Object IDs (campaign/adset/ad) must be numeric — blocks path/param injection. */
function assertObjectId(id: string, label: string): string {
  const clean = id.trim();
  if (!/^\d{5,25}$/.test(clean)) throw new Error(`Invalid ${label}: '${id}' (expected numeric ID).`);
  return clean;
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

const server = new McpServer({ name: "meta-ads-mcp-server", version: "2.0.0" });

server.registerTool(
  "meta_list_ad_accounts",
  {
    title: "List Ad Accounts",
    description: `List every ad account this server's token can access (filtered by the server allowlist, if configured). Call this FIRST when the user has multiple accounts, then pass the chosen account_id to other tools.

Returns JSON: { count, accounts: [{ account_id, name, currency, account_status (1=active, 2=disabled, 3=unsettled, 101=closed), amount_spent }] }`,
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => {
    try {
      const accounts = await client.getAllPages<Record<string, unknown>>(
        "me/adaccounts",
        { fields: "account_id,name,currency,account_status,amount_spent", limit: 50 },
        3
      );
      const visible = ALLOWLIST
        ? accounts.filter((a) => ALLOWLIST.has(String(a.account_id)))
        : accounts;
      return ok({ count: visible.length, default_account: DEFAULT_ACCOUNT, accounts: visible });
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
    inputSchema: { account_id: AccountIdParam },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ account_id }) => {
    try {
      const acct = resolveAccount(account_id);
      const data = await client.get<Record<string, unknown>>(`act_${acct}`, {
        fields: "id,name,currency,timezone_name,account_status,amount_spent,spend_cap",
      });
      return ok(data);
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
      status: EffectiveStatus,
      limit: z.number().int().min(1).max(100).default(25),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ account_id, status, limit }) => {
    try {
      const acct = resolveAccount(account_id);
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
      campaign_id: z.string().optional().describe("Restrict to one campaign"),
      status: EffectiveStatus,
      limit: z.number().int().min(1).max(100).default(25),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ account_id, campaign_id, status, limit }) => {
    try {
      const parent = campaign_id
        ? assertObjectId(campaign_id, "campaign_id")
        : `act_${resolveAccount(account_id)}`;
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
      parent_id: z.string().optional().describe("Campaign or ad set ID to filter by"),
      status: EffectiveStatus,
      limit: z.number().int().min(1).max(100).default(25),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ account_id, parent_id, status, limit }) => {
    try {
      const parent = parent_id
        ? assertObjectId(parent_id, "parent_id")
        : `act_${resolveAccount(account_id)}`;
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
      object_id: z.string().optional().describe("Campaign/adset/ad ID; omit for whole account"),
      level: z.enum(["account", "campaign", "adset", "ad"]).default("campaign"),
      date_preset: DatePreset.default("last_30d"),
      time_increment: z.enum(["1", "7", "28"]).optional().describe("'1' = one row per day"),
      breakdown: z
        .enum(["age", "gender", "country", "region", "publisher_platform", "platform_position", "device_platform"])
        .optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ account_id, object_id, level, date_preset, time_increment, breakdown, limit }) => {
    try {
      const parent = object_id
        ? assertObjectId(object_id, "object_id")
        : `act_${resolveAccount(account_id)}`;
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

Returns JSON: { goal_action, window, totals { spend, results, blended_cost_per_result, median_cost_per_result }, summary: string[], entities: [{ id, name, spend, results, cost_per_result, ctr, cpm, frequency, verdict, reasons[], recommendation, trend { prev_*, cpr_change_pct, ctr_change_pct } }] }

The server only reads data — pausing/scaling is always the human's decision.

Args:
  - account_id: optional (default account if omitted)
  - level: campaign | adset | ad (default adset — the level where budgets usually live)
  - goal_action: lead | purchase | contact | complete_registration | donate | link_click (default lead)
  - lookback_days: 3-90 (default 7). Previous window = same length immediately before.
  - min_spend: spend threshold (account currency) below which no verdict is issued (default 5)

Examples:
  - "কোন ক্যাম্পেইনে লস করছি?" -> level=campaign, lookback_days=7
  - "Which ads should I scale this month?" -> level=ad, lookback_days=30`,
    inputSchema: {
      account_id: AccountIdParam,
      level: z.enum(["campaign", "adset", "ad"]).default("adset"),
      goal_action: GoalAction,
      lookback_days: z.number().int().min(3).max(90).default(7),
      min_spend: z.number().min(0).max(100000).default(5),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ account_id, level, goal_action, lookback_days, min_spend }) => {
    try {
      const acct = resolveAccount(account_id);
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
      return ok({ account_id: acct, ...result });
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Transport + security layers 3-5 (auth, rate limit, hardened HTTP)
// ---------------------------------------------------------------------------

async function runStdio(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error("meta-ads-mcp-server v2 on stdio");
}

/** Layer 4: simple in-memory per-IP rate limit (fixed 60 req/min window). */
function makeRateLimiter(maxPerMinute: number) {
  const hits = new Map<string, { count: number; windowStart: number }>();
  return (ip: string): boolean => {
    const now = Date.now();
    const rec = hits.get(ip);
    if (!rec || now - rec.windowStart > 60_000) {
      hits.set(ip, { count: 1, windowStart: now });
      return true;
    }
    rec.count++;
    if (hits.size > 10_000) hits.clear(); // memory guard
    return rec.count <= maxPerMinute;
  };
}

async function runHttp(): Promise<void> {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  const authToken = process.env.MCP_AUTH_TOKEN;
  const pathSecret = process.env.MCP_PATH_SECRET;
  if (!authToken && !pathSecret) {
    console.error(
      "WARNING: neither MCP_AUTH_TOKEN nor MCP_PATH_SECRET is set — /mcp is open to anyone who can reach this server. Set one before exposing publicly."
    );
  }
  if (pathSecret && !/^[A-Za-z0-9_-]{16,128}$/.test(pathSecret)) {
    console.error("MCP_PATH_SECRET must be 16-128 chars of [A-Za-z0-9_-]. Generate: openssl rand -hex 24");
    process.exit(1);
  }
  const mcpPath = pathSecret ? `/mcp/${pathSecret}` : "/mcp";
  const allowed = makeRateLimiter(60);

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, version: "2.0.0" });
  });

  app.post(mcpPath, async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    const ip = req.ip || "unknown";
    if (!allowed(ip)) {
      res.status(429).json({ error: "Rate limit exceeded (60 req/min per IP)" });
      return;
    }
    if (authToken) {
      // Layer 3: constant-length comparison not critical here, but avoid logging header.
      if ((req.headers.authorization || "") !== `Bearer ${authToken}`) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request failed:", err instanceof Error ? err.message : err);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
  });

  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, () => {
    console.error(`meta-ads-mcp-server v2 listening on :${port}${mcpPath.replace(pathSecret ?? "", pathSecret ? "<secret>" : "")} (auth: ${authToken ? "ON" : "OFF"}, allowlist: ${ALLOWLIST ? [...ALLOWLIST].join(",") : "none"})`);
  });
}

((process.env.TRANSPORT || "http") === "stdio" ? runStdio : runHttp)().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
