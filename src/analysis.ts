/**
 * Pure analysis engine — no I/O, fully unit-testable.
 * Turns raw Meta insight rows into classified verdicts + recommendations.
 */

export interface ActionEntry {
  action_type: string;
  value: string;
}

export interface InsightRow {
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  frequency?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  actions?: ActionEntry[];
  cost_per_action_type?: ActionEntry[];
  date_start?: string;
  date_stop?: string;
}

export type Verdict =
  | "LOSING"
  | "UNDERPERFORMING"
  | "HEALTHY"
  | "SCALE_CANDIDATE"
  | "FATIGUED"
  | "INSUFFICIENT_DATA";

export interface EntityAnalysis {
  id: string;
  name: string;
  level: "campaign" | "adset" | "ad";
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpm: number;
  frequency: number;
  results: number;
  cost_per_result: number | null;
  verdict: Verdict;
  reasons: string[];
  recommendation: string;
  trend?: {
    prev_spend: number;
    prev_results: number;
    prev_cost_per_result: number | null;
    cpr_change_pct: number | null;
    ctr_change_pct: number | null;
  };
}

export interface AccountAnalysis {
  goal_action: string;
  window: string;
  totals: {
    spend: number;
    results: number;
    blended_cost_per_result: number | null;
    median_cost_per_result: number | null;
  };
  entities: EntityAnalysis[];
  summary: string[];
}

const num = (v: string | undefined): number => {
  const n = parseFloat(v ?? "0");
  return Number.isFinite(n) ? n : 0;
};

/**
 * Extract result count for a goal action from Meta's actions array.
 * Meta's "lead" action_type is already the deduplicated total across
 * website + on-Facebook leads, so prefer it; only fall back to summing
 * channel-specific types when the aggregate is absent.
 */
export function extractResults(actions: ActionEntry[] | undefined, goal: string): number {
  if (!actions?.length) return 0;
  const find = (t: string) => actions.find((a) => a.action_type === t);

  const aggregate = find(goal);
  if (aggregate) return num(aggregate.value);

  const fallbacks: Record<string, string[]> = {
    lead: ["onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead", "leadgen_grouped"],
    purchase: ["onsite_conversion.purchase", "offsite_conversion.fb_pixel_purchase", "omni_purchase"],
    contact: ["onsite_conversion.messaging_conversation_started_7d", "offsite_conversion.fb_pixel_contact"],
    complete_registration: ["offsite_conversion.fb_pixel_complete_registration"],
    donate: ["offsite_conversion.fb_pixel_donate"],
  };
  let sum = 0;
  for (const t of fallbacks[goal] ?? []) {
    const f = find(t);
    if (f) sum += num(f.value);
  }
  return sum;
}

function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const pctChange = (curr: number, prev: number): number | null =>
  prev > 0 ? Math.round(((curr - prev) / prev) * 1000) / 10 : null;

export interface AnalyzeOptions {
  goal_action: string;
  level: "campaign" | "adset" | "ad";
  window: string;
  /** Spend below this (account currency) => INSUFFICIENT_DATA. */
  min_spend: number;
  currency: string;
}

export function analyze(
  rows: InsightRow[],
  prevRows: InsightRow[] | null,
  opts: AnalyzeOptions
): AccountAnalysis {
  const idOf = (r: InsightRow) =>
    (opts.level === "campaign" ? r.campaign_id : opts.level === "adset" ? r.adset_id : r.ad_id) ?? "unknown";
  const nameOf = (r: InsightRow) =>
    (opts.level === "campaign" ? r.campaign_name : opts.level === "adset" ? r.adset_name : r.ad_name) ??
    "(unnamed)";

  const prevById = new Map<string, InsightRow>();
  for (const r of prevRows ?? []) prevById.set(idOf(r), r);

  // First pass — raw metrics per entity
  const base = rows.map((r) => {
    const spend = num(r.spend);
    const results = extractResults(r.actions, opts.goal_action);
    return {
      row: r,
      id: idOf(r),
      name: nameOf(r),
      spend,
      impressions: num(r.impressions),
      clicks: num(r.clicks),
      ctr: num(r.ctr),
      cpm: num(r.cpm),
      frequency: num(r.frequency),
      results,
      cpr: results > 0 ? spend / results : null,
    };
  });

  const medianCpr = median(base.filter((b) => b.cpr !== null).map((b) => b.cpr as number));
  const totalSpend = base.reduce((s, b) => s + b.spend, 0);
  const totalResults = base.reduce((s, b) => s + b.results, 0);

  const entities: EntityAnalysis[] = base.map((b) => {
    const reasons: string[] = [];
    let verdict: Verdict;

    const enoughData = b.spend >= opts.min_spend && b.impressions >= 500;

    if (!enoughData) {
      verdict = "INSUFFICIENT_DATA";
      reasons.push(
        `Spend ${b.spend.toFixed(2)} ${opts.currency} / ${b.impressions} impressions — below the ${opts.min_spend} ${opts.currency} / 500-impression threshold for a reliable verdict.`
      );
    } else if (b.results === 0) {
      verdict = "LOSING";
      reasons.push(
        `Spent ${b.spend.toFixed(2)} ${opts.currency} with zero '${opts.goal_action}' results.`
      );
      if (medianCpr !== null)
        reasons.push(`Peers achieve results at ~${medianCpr.toFixed(2)} ${opts.currency} each.`);
    } else if (medianCpr !== null && (b.cpr as number) > medianCpr * 2) {
      verdict = "LOSING";
      reasons.push(
        `Cost per result ${(b.cpr as number).toFixed(2)} is >2x the account median (${medianCpr.toFixed(2)}).`
      );
    } else if (b.frequency > 3.5) {
      verdict = "FATIGUED";
      reasons.push(
        `Frequency ${b.frequency.toFixed(1)} — the same people are seeing this too often; performance typically decays past ~3.5.`
      );
    } else if (medianCpr !== null && (b.cpr as number) > medianCpr * 1.3) {
      verdict = "UNDERPERFORMING";
      reasons.push(
        `Cost per result ${(b.cpr as number).toFixed(2)} is ${Math.round((((b.cpr as number) - medianCpr) / medianCpr) * 100)}% above the account median.`
      );
    } else if (
      medianCpr !== null &&
      (b.cpr as number) <= medianCpr * 0.7 &&
      b.results >= 3 &&
      b.frequency <= 3
    ) {
      verdict = "SCALE_CANDIDATE";
      reasons.push(
        `Cost per result ${(b.cpr as number).toFixed(2)} is well below median (${medianCpr.toFixed(2)}), with ${b.results} results and healthy frequency (${b.frequency.toFixed(1)}).`
      );
    } else {
      verdict = "HEALTHY";
      reasons.push(`Metrics are within a normal band for this account.`);
    }

    // Trend vs previous window
    let trend: EntityAnalysis["trend"];
    const prev = prevById.get(b.id);
    if (prev) {
      const pSpend = num(prev.spend);
      const pResults = extractResults(prev.actions, opts.goal_action);
      const pCpr = pResults > 0 ? pSpend / pResults : null;
      const pCtr = num(prev.ctr);
      trend = {
        prev_spend: Math.round(pSpend * 100) / 100,
        prev_results: pResults,
        prev_cost_per_result: pCpr !== null ? Math.round(pCpr * 100) / 100 : null,
        cpr_change_pct: b.cpr !== null && pCpr !== null ? pctChange(b.cpr, pCpr) : null,
        ctr_change_pct: pctChange(b.ctr, pCtr),
      };
      if (
        verdict === "HEALTHY" &&
        trend.ctr_change_pct !== null &&
        trend.ctr_change_pct < -30 &&
        b.spend >= opts.min_spend
      ) {
        verdict = "FATIGUED";
        reasons.push(`CTR dropped ${Math.abs(trend.ctr_change_pct)}% vs the previous period — early fatigue signal.`);
      }
      if (trend.cpr_change_pct !== null && trend.cpr_change_pct > 50) {
        reasons.push(`Cost per result rose ${trend.cpr_change_pct}% vs the previous period.`);
      }
    }

    const recommendation =
      verdict === "LOSING"
        ? "PAUSE this and reallocate its budget to a SCALE_CANDIDATE. Review before relaunching with new creative/targeting."
        : verdict === "UNDERPERFORMING"
          ? "Watch 3-4 more days. If cost per result stays >30% above median, pause. Consider refreshing the creative."
          : verdict === "FATIGUED"
            ? "Refresh the creative (new image/video/copy) or broaden the audience; do NOT increase budget on a fatigued ad."
            : verdict === "SCALE_CANDIDATE"
              ? "Increase daily budget by 20-30% (not more — bigger jumps reset Meta's learning phase). Re-check in 3-4 days."
              : verdict === "INSUFFICIENT_DATA"
                ? "Let it run — verdicts need more spend/impressions to be statistically meaningful."
                : "Keep running as-is.";

    return {
      id: b.id,
      name: b.name,
      level: opts.level,
      spend: Math.round(b.spend * 100) / 100,
      impressions: b.impressions,
      clicks: b.clicks,
      ctr: Math.round(b.ctr * 100) / 100,
      cpm: Math.round(b.cpm * 100) / 100,
      frequency: Math.round(b.frequency * 100) / 100,
      results: b.results,
      cost_per_result: b.cpr !== null ? Math.round(b.cpr * 100) / 100 : null,
      verdict,
      reasons,
      recommendation,
      ...(trend ? { trend } : {}),
    };
  });

  // Sort: worst offenders first, then scale candidates
  const order: Record<Verdict, number> = {
    LOSING: 0,
    FATIGUED: 1,
    UNDERPERFORMING: 2,
    SCALE_CANDIDATE: 3,
    HEALTHY: 4,
    INSUFFICIENT_DATA: 5,
  };
  entities.sort((a, b) => order[a.verdict] - order[b.verdict] || b.spend - a.spend);

  const losing = entities.filter((e) => e.verdict === "LOSING");
  const scalers = entities.filter((e) => e.verdict === "SCALE_CANDIDATE");
  const wastedSpend = losing.reduce((s, e) => s + e.spend, 0);

  const summary: string[] = [
    `Total: ${totalSpend.toFixed(2)} ${opts.currency} spent, ${totalResults} '${opts.goal_action}' results` +
      (totalResults > 0 ? ` (blended ${(totalSpend / totalResults).toFixed(2)} ${opts.currency} each).` : "."),
  ];
  if (losing.length)
    summary.push(
      `${losing.length} ${opts.level}(s) classified LOSING — ~${wastedSpend.toFixed(2)} ${opts.currency} of the window's spend produced poor/no results: ${losing.map((e) => e.name).join(", ")}.`
    );
  if (scalers.length)
    summary.push(`Scale candidates: ${scalers.map((e) => e.name).join(", ")} — shift budget here.`);
  if (!losing.length && !scalers.length)
    summary.push("No clear losers or scale candidates — account is balanced or needs more data.");
  if (totalResults === 0 && totalSpend > 0)
    summary.push(
      `WARNING: zero '${opts.goal_action}' results recorded. Either the pixel event isn't firing (check Events Manager) or the window is too short.`
    );

  return {
    goal_action: opts.goal_action,
    window: opts.window,
    totals: {
      spend: Math.round(totalSpend * 100) / 100,
      results: totalResults,
      blended_cost_per_result:
        totalResults > 0 ? Math.round((totalSpend / totalResults) * 100) / 100 : null,
      median_cost_per_result: medianCpr !== null ? Math.round(medianCpr * 100) / 100 : null,
    },
    entities,
    summary,
  };
}
