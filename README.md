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




# Meta Ads MCP Server (v3) — সম্পূর্ণ A-to-Z সেটআপ গাইড

আপনার সব Business portfolio-র অ্যাড অ্যাকাউন্ট Claude-এর সাথে যুক্ত করার পূর্ণাঙ্গ গাইড। মোট সময়: প্রথমবারে ৪৫-৬০ মিনিট।

---

## ধাপ ০: প্রস্তুতি (৫ মিনিট)

যা যা লাগবে:
- [ ] **Node.js 20+** — `node -v` দিয়ে চেক করুন; না থাকলে nodejs.org থেকে LTS ইনস্টল
- [ ] **Git** — `git -v` দিয়ে চেক
- [ ] **GitHub অ্যাকাউন্ট** (আছে)
- [ ] **Railway অ্যাকাউন্ট** — railway.com এ GitHub দিয়ে সাইনআপ (ট্রায়ালে $5 ফ্রি ক্রেডিট; পরে Hobby প্ল্যান $5/মাস)
- [ ] `meta-ads-mcp-server-v3.zip` এক্সট্র্যাক্ট করুন, যেমন: `D:\projects\meta-ads-mcp-server`

---

## ধাপ ১: প্রতিটা Business Portfolio-র জন্য Permanent Token (১০ মিনিট/portfolio)

> এই ধাপটা **প্রতিটা portfolio-র জন্য আলাদাভাবে** করতে হবে (Ilm-Ul-Quran USA, Al Quranul Hakim, Deenova Academy...)। সব একদিনে না করলেও চলবে — যেটার token দেবেন, সেটাই কাজ করবে; বাকিগুলো পরে যোগ করা যায়।

### ১.১ — App বানান (একবারই, সব portfolio-তে একই app চলবে না — যে portfolio-র সাথে app যুক্ত সেটাতে; সহজ নিয়ম: মূল portfolio-তে একটা বানান)
1. **developers.facebook.com** → My Apps → **Create App**
2. Use case: **Other** → Type: **Business** → নাম: `IQU Reporting` → Create
3. App dev mode-এ থাকলেই চলবে — নিজের ad account পড়ার জন্য review লাগে না

### ১.২ — System User বানান (প্রতি portfolio-তে)
1. **business.facebook.com** → উপরে বাম দিক থেকে portfolio সিলেক্ট করুন
2. Settings (⚙️) → **Users → System users** → **Add**
3. নাম: `mcp-reader` | Role: **Employee** → Create

### ১.৩ — Ad account assign করুন
1. সেই system user-এ ক্লিক → **Add assets**
2. **Ad accounts** → account(গুলো) সিলেক্ট
3. শুধু **View performance** টগল অন (Manage দেবেন না!) → Save

### ১.৪ — Token জেনারেট
1. **Generate new token** → App: `IQU Reporting` সিলেক্ট
2. Token expiration: **Never**
3. Permissions: শুধু **`ads_read`** ✅
4. Generate → token কপি করে নিরাপদ জায়গায় রাখুন (Notepad-এ portfolio-র নামসহ) — এই স্ক্রিন আর ফিরে আসবে না

> ⚠️ যদি কোনো portfolio-তে system user-এ app assign করতে সমস্যা হয় (app অন্য portfolio-র বলে): সেই portfolio-তেও ছোট একটা app বানিয়ে নিন (১.১ রিপিট), অথবা app-টা Business Settings → Accounts → Apps → Assign partners দিয়ে শেয়ার করুন।

### ১.৫ — Ad Account ID সংগ্রহ
প্রতিটা portfolio-র Ads Manager URL-এ `act=` এর পরের সংখ্যা, অথবা Business Settings → Accounts → Ad accounts। যেমন IQU-র: `2121321328625710`

শেষে আপনার Notepad-এ এমন একটা তালিকা থাকবে:
```
iqu            → EAAB...(token)   → account: 2121321328625710
alquranulhakim → EAAB...(token)   → account: XXXXXXXXXX
deenova        → EAAB...(token)   → account: XXXXXXXXXX
```

---

## ধাপ ২: লোকাল টেস্ট (৫ মিনিট)

PowerShell খুলে প্রজেক্ট ফোল্ডারে যান:

```powershell
cd D:\projects\meta-ads-mcp-server
npm install
npm run build
```

Env var সেট করে চালান (নিজের token বসিয়ে — JSON-টা এক লাইনে):

```powershell
$env:META_TOKENS='{"iqu":"EAAB-আপনার-iqu-token","deenova":"EAAB-deenova-token"}'
$env:META_DEFAULT_PORTFOLIO="iqu"
npm start
```

দেখবেন: `meta-ads-mcp-server v3 on :3000/mcp | portfolios: iqu, deenova ...`

ব্রাউজারে যাচাই: **http://localhost:3000/healthz** → `{"ok":true,"version":"3.0.0","portfolios":["iqu","deenova"]}`

টোকেন আসল কিনা যাচাই (নতুন PowerShell ট্যাবে):
```powershell
curl.exe -s -X POST http://localhost:3000/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"meta_list_ad_accounts\",\"arguments\":{}}}'
```
রেসপন্সে আপনার account-এর নাম দেখালে ✅। `[190]` এরর দেখালে token ভুল — ধাপ ১.৪ আবার করুন।

---

## ধাপ ৩: GitHub-এ Push (৫ মিনিট)

1. github.com → New repository → নাম: `meta-ads-mcp-server` → **Private** ✅ → Create
2. PowerShell-এ:

```powershell
cd D:\projects\meta-ads-mcp-server
git init
git add .
git commit -m "meta-ads-mcp-server v3"
git branch -M main
git remote add origin https://github.com/আপনার-username/meta-ads-mcp-server.git
git push -u origin main
```

> `.gitignore` আগে থেকেই দেওয়া আছে — token কখনো repo-তে যাবে না। token সবসময় env var-এ।

---

## ধাপ ৪: Railway-তে ডিপ্লয় (১০ মিনিট)

1. **railway.com** → Login with GitHub
2. **New Project → Deploy from GitHub repo** → `meta-ads-mcp-server` সিলেক্ট (প্রথমবারে GitHub access দিতে বলবে)
3. Build অটো শুরু হবে (`npm install` → `npm run build` → `npm start`)
4. প্রজেক্টে ঢুকে **Variables** ট্যাব → নিচেরগুলো যোগ করুন:

| Variable | Value |
|---|---|
| `META_TOKENS` | `{"iqu":"EAAB...","deenova":"EAAB...","alquranulhakim":"EAAB..."}` |
| `META_DEFAULT_PORTFOLIO` | `iqu` |
| `MCP_AUTH_TOKEN` | ৪০+ অক্ষরের র‍্যান্ডম স্ট্রিং* |

\* PowerShell-এ বানান: `-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | % {[char]$_})` — এটাও Notepad-এ রাখুন

5. Variables সেভ করলে অটো redeploy হবে
6. **Settings → Networking → Generate Domain** → URL পাবেন: `https://xxxx.up.railway.app`
7. ব্রাউজারে যাচাই: `https://xxxx.up.railway.app/healthz` → `{"ok":true,...}` ✅

---

## ধাপ ৫: Claude.ai-তে Connector যোগ (৫ মিনিট)

1. **claude.ai → Settings → Connectors → Add custom connector**
2. Name: `Meta Ads`
3. URL: `https://xxxx.up.railway.app/mcp`
4. **Authentication:** ফর্মে যদি **request headers / API key** ফিল্ড থাকে:
   - Header: `Authorization`
   - Value: `Bearer আপনার-MCP_AUTH_TOKEN` (Bearer শব্দটা + স্পেস + token)
5. **Add** → connector লিস্টে দেখাবে

### 🔀 Fallback — যদি header ফিল্ড না থাকে (শুধু OAuth ফিল্ড দেখায়):
1. Railway Variables-এ `MCP_AUTH_TOKEN` **ডিলিট** করুন
2. নতুন variable: `MCP_PATH_SECRET` = ২৪+ অক্ষরের র‍্যান্ডম স্ট্রিং (শুধু a-z, A-Z, 0-9)
3. Connector URL দিন: `https://xxxx.up.railway.app/mcp/সেই-secret`
4. Secret ছাড়া `/mcp` তখন 404 দেয় — নিরাপদ

---

## ধাপ ৬: যাচাই ও ব্যবহার

নতুন চ্যাট → attachment/tools মেনু থেকে **Meta Ads** connector অন → লিখুন:

> **"List all my ad accounts across all portfolios, then run meta_analyze_performance on the IQU account for the last 7 days. Tell me what to pause and what to scale."**

Portfolio-অনুযায়ী account লিস্ট + verdict (LOSING/SCALE_CANDIDATE...) এলে সব সম্পন্ন ✅

### সাপ্তাহিক রুটিন (প্রতি রবিবার, ২ মিনিট):
> *"গত ৭ দিনের সব অ্যাকাউন্ট বিশ্লেষণ করো — কোনটা pause, কোনটা scale, কত টাকা নষ্ট হয়েছে?"*

Claude verdict দেবে, আপনি Ads Manager-এ গিয়ে ২ ক্লিকে সিদ্ধান্ত কার্যকর করবেন।

---

## ট্রাবলশুটিং

| সমস্যা | সমাধান |
|---|---|
| "Couldn't reach the MCP server" | `/healthz` ব্রাউজারে চলে? Railway → Deployments → logs দেখুন |
| `401 Unauthorized` | Header-এর token আর Railway-র `MCP_AUTH_TOKEN` হুবহু এক? `Bearer ` প্রিফিক্স আছে? |
| Meta error `[190]` | Token ভুল/expired — ধাপ ১.৪ থেকে নতুন token, Railway variable আপডেট |
| Meta error `[100]` / permission | System user-এ ad account assign হয়নি — ধাপ ১.৩ |
| `errors: [deenova] ...` কিন্তু iqu চলছে | শুধু deenova-র token সমস্যা — ওটাই ঠিক করুন, বাকি সব সচল |
| সব ad-এ results = 0 + WARNING | Pixel-এ **Lead event** ফায়ার হচ্ছে না — Events Manager চেক করুন |
| Railway build fail | Logs-এ error দেখুন; সাধারণত Node version — Settings-এ Node 20 নিশ্চিত করুন |

## নিরাপত্তা চেকলিস্ট

- [ ] সব token-এ শুধু `ads_read` (ads_management **না**)
- [ ] GitHub repo **Private**
- [ ] `MCP_AUTH_TOKEN` বা `MCP_PATH_SECRET` — অন্তত একটা সেট করা
- [ ] Token কখনো চ্যাট/স্ক্রিনশট/কোডে শেয়ার না করা
- [ ] আগে Events Manager-এর স্ক্রিনশটে যে CAPI token এক্সপোজ হয়েছিল, সেটা regenerate করা

## পরে নতুন Portfolio যোগ করতে

১. সেই portfolio-তে ধাপ ১.২–১.৪ → নতুন token
২. Railway → Variables → `META_TOKENS` JSON-এ নতুন `"alias":"token"` জোড়া যোগ → Save
৩. ব্যস — কোড বদলাতে হবে না, redeploy অটো হবে