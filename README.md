# meta-ads-mcp-server v3

Read-only MCP server for the Meta Marketing API with a built-in **performance analysis engine**. Connect to Claude.ai as a custom connector, then ask in plain Bangla/English: *"কোন ক্যাম্পেইনে লস করছি?"* — Claude pulls live data and returns verdicts.

**Deliberately read-only.** The server can never pause, edit or spend — every action stays a human decision.

## Tools

| Tool | Purpose |
|---|---|
| `meta_list_ad_accounts` | All ad accounts across ALL portfolios/tokens, grouped by portfolio |
| `meta_get_account_overview` | Name, currency, status, lifetime spend |
| `meta_list_campaigns` / `meta_list_adsets` / `meta_list_ads` | Structure + budgets + targeting |
| `meta_get_insights` | Raw metrics, daily series, age/gender/placement breakdowns |
| `meta_analyze_performance` | **The star.** Current vs previous window, cost-per-result vs account median, classifies every campaign/adset/ad |

### Analysis verdicts (meta_analyze_performance)

| Verdict | Trigger | Recommendation returned |
|---|---|---|
| `LOSING` | Meaningful spend + 0 results, or cost/result > 2× account median | Pause, reallocate budget |
| `UNDERPERFORMING` | Cost/result > 1.3× median | Watch 3-4 days, refresh creative |
| `FATIGUED` | Frequency > 3.5, or CTR fell >30% vs previous window | New creative, don't raise budget |
| `SCALE_CANDIDATE` | Cost/result ≤ 0.7× median, ≥3 results, frequency ≤ 3 | +20-30% budget (protects learning phase) |
| `HEALTHY` / `INSUFFICIENT_DATA` | — | Keep running / wait for data |

Every entity also gets week-over-week trend (spend, results, CPL change %, CTR change %). If the whole account shows zero results, the summary warns that the pixel Lead event may not be firing.

## Security layers

1. **Env validation** — refuses to boot without a token
2. **Account allowlist** — `META_AD_ACCOUNT_IDS=111,222` → only those accounts queryable, all IDs regex-validated (blocks path/param injection)
3. **Bearer auth** — `MCP_AUTH_TOKEN` (header) or `MCP_PATH_SECRET` (secret URL path `/mcp/<secret>` for connector UIs without header fields) — server warns loudly if neither is set
4. **Rate limiting** — 60 req/min per IP, in-memory
5. **Token hygiene** — access token redacted from every error message; never logged
6. **Hardened HTTP** — 1MB body cap, x-powered-by disabled, nosniff, retry/backoff on Meta throttling (codes 4/17/32/613), 30s timeouts, non-JSON responses handled gracefully

## Setup

### 1. Token (System User = permanent, recommended)
Business Settings → Users → **System Users** → Add → assign your ad account(s) with *View performance* → Generate token with **`ads_read`** only. (Quick testing: Graph API Explorer token also works but expires.)

### 2. Run
Single portfolio:
```bash
META_ACCESS_TOKEN=EAAB... MCP_AUTH_TOKEN=$(openssl rand -hex 24) npm start
```
**Multiple portfolios (one permanent System User token per Business portfolio):**
```bash
META_TOKENS='{"iqu":"EAAB...","alquranulhakim":"EAAB...","deenova":"EAAB..."}' \
META_DEFAULT_PORTFOLIO=iqu \
MCP_AUTH_TOKEN=$(openssl rand -hex 24) npm start
```
Tools accept an optional `portfolio` param, but you rarely need it: the server builds an account->portfolio map (cached 10 min) and auto-routes every `account_id` to the right token. A portfolio whose token fails is reported in `errors` without blocking the others.
Optional: `META_AD_ACCOUNT_IDS=111,222` global allowlist, `META_DEFAULT_ACCOUNT=111`.

### 3. Deploy (Claude.ai needs public HTTPS)
Railway/Render: push to GitHub → new project → set the 3 env vars → done. Quick test: `cloudflared tunnel --url http://localhost:3000`.

### 4. Connect in Claude.ai
Settings → Connectors → Add custom connector → `https://your-host/mcp` (+ Authorization: `Bearer <MCP_AUTH_TOKEN>`).

First prompt to try: **"List my ad accounts, then analyze last 7 days performance and tell me what to pause and what to scale."**

## Env reference

| Var | Required | Notes |
|---|---|---|
| `META_TOKENS` | ✅ (or META_ACCESS_TOKEN) | JSON: `{"alias":"token",...}` — one System User token per portfolio, `ads_read` only |
| `META_ACCESS_TOKEN` | alt | Single token (alias `default`) |
| `META_DEFAULT_PORTFOLIO` | optional | Alias used when calls omit portfolio |
| `META_AD_ACCOUNT_IDS` | recommended | Comma-separated allowlist |
| `META_DEFAULT_ACCOUNT` | optional | Used when tools omit account_id |
| `MCP_AUTH_TOKEN` | strongly recommended | Bearer secret for /mcp |
| `META_API_VERSION` | optional | default v21.0 |
| `PORT` / `TRANSPORT` | optional | 3000 / http (or stdio) |

## Tests
`node test/test_analysis.mjs` — 17 unit tests covering every verdict path, lead dedup (Meta's aggregate `lead` vs channel-specific types), trends, and the zero-results pixel warning. Integration-tested: 401s, allowlist rejection, ID-injection guard, token redaction.
