/**
 * Meta Graph API client.
 * - Timeout on every request
 * - Automatic retry with backoff on Meta rate-limit error codes
 * - Access token never appears in thrown error messages or logs
 */

const API_VERSION = process.env.META_API_VERSION || "v21.0";
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRYABLE_CODES = new Set([4, 17, 32, 613]); // Meta throttling codes

export interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
  };
}

export interface Paged<T> {
  data: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

function redact(text: string, token: string): string {
  return token ? text.split(token).join("<redacted-token>") : text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class MetaClient {
  constructor(private readonly accessToken: string) {}

  async get<T>(
    path: string,
    params: Record<string, string | number | undefined> = {}
  ): Promise<T> {
    const url = new URL(`${BASE_URL}/${path}`);
    url.searchParams.set("access_token", this.accessToken);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const raw = await res.text();
        let json: T & GraphErrorBody;
        try {
          json = JSON.parse(raw) as T & GraphErrorBody;
        } catch {
          throw new Error(
            redact(
              `Meta API returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 200)} — check network/proxy access to graph.facebook.com.`,
              this.accessToken
            )
          );
        }

        if (!res.ok || json.error) {
          const e = json.error;
          const code = e?.code;
          if (code !== undefined && RETRYABLE_CODES.has(code) && attempt < MAX_RETRIES) {
            await sleep(1500 * (attempt + 1));
            continue;
          }
          const hint =
            code === 190
              ? " (Token invalid/expired — generate a new one; a System User token is permanent.)"
              : code === 100
                ? " (ID not found or token lacks ads_read on this ad account.)"
                : code !== undefined && RETRYABLE_CODES.has(code)
                  ? " (Meta rate limit — wait a few minutes and retry.)"
                  : code === 200 || code === 10
                    ? " (Permission error — grant the token 'ads_read' access to this ad account.)"
                    : "";
          throw new Error(
            redact(`Meta API error [${code ?? res.status}]: ${e?.message || `HTTP ${res.status}`}${hint}`, this.accessToken)
          );
        }
        return json;
      } catch (err) {
        if (err instanceof Error) {
          lastError = new Error(redact(err.message, this.accessToken));
          if (err.name === "TimeoutError" && attempt < MAX_RETRIES) {
            await sleep(1000 * (attempt + 1));
            continue;
          }
          if (err.message.startsWith("Meta API error")) throw lastError;
        } else {
          lastError = new Error("Unknown fetch failure");
        }
      }
    }
    throw lastError ?? new Error("Request failed after retries");
  }

  /** Fetch up to maxPages of a paged edge, concatenated. */
  async getAllPages<T>(
    path: string,
    params: Record<string, string | number | undefined>,
    maxPages = 4
  ): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.get<Paged<T>>(path, { ...params, after });
      out.push(...res.data);
      after = res.paging?.cursors?.after;
      if (!after || !res.paging?.next) break;
    }
    return out;
  }
}
