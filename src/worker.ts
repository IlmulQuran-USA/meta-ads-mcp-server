/**
 * Cloudflare Workers entry — stateless MCP (JSON-RPC over HTTP POST).
 *
 * The MCP SDK's StreamableHTTPServerTransport needs Node req/res objects, so
 * instead we feed each incoming JSON-RPC message straight into McpServer via a
 * minimal one-shot transport and return the single reply as JSON. This is the
 * same wire behaviour as sessionIdGenerator:undefined + enableJsonResponse:true.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

type Env = Record<string, string | undefined>;

class OneShotTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  readonly reply: Promise<JSONRPCMessage | null>;
  private settle!: (m: JSONRPCMessage | null) => void;

  constructor() {
    this.reply = new Promise((resolve) => {
      this.settle = resolve;
    });
  }
  async start(): Promise<void> {}
  async send(message: JSONRPCMessage): Promise<void> {
    this.settle(message);
  }
  async close(): Promise<void> {
    this.settle(null);
    this.onclose?.();
  }
}

// One McpServer instance per isolate -> serialise requests so connect() calls
// never overlap.
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function handleRpc(msg: any): Promise<JSONRPCMessage | null> {
  const { server } = await import("./index.js");
  return serialize(async () => {
    const transport = new OneShotTransport();
    await server.connect(transport);
    try {
      const isRequest =
        msg && typeof msg === "object" && typeof msg.method === "string" && msg.id !== undefined;
      transport.onmessage?.(msg as JSONRPCMessage);
      if (!isRequest) return null; // notification -> no response body
      return await Promise.race([
        transport.reply,
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error("MCP handler timed out")), 60_000)
        ),
      ]);
    } finally {
      await server.close().catch(() => {});
    }
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-content-type-options": "nosniff" },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Belt-and-braces: nodejs_compat already mirrors vars/secrets into
    // process.env, which src/index.ts and src/meta.ts read at module scope.
    try {
      for (const [k, v] of Object.entries(env)) {
        if (typeof v === "string" && process.env[k] === undefined) process.env[k] = v;
      }
    } catch {
      /* process.env is read-only in some runtimes — bindings already applied */
    }

    const url = new URL(request.url);
    const pathSecret = env.MCP_PATH_SECRET;
    const authToken = env.MCP_AUTH_TOKEN;
    const mcpPath = pathSecret ? `/mcp/${pathSecret}` : "/mcp";

    if (url.pathname === "/healthz") {
      const { PORTFOLIO_ALIASES } = await import("./index.js");
      return json({ ok: true, version: "3.0.0", runtime: "workers", portfolios: PORTFOLIO_ALIASES });
    }

    if (url.pathname !== mcpPath) return json({ error: "Not found" }, 404);

    if (request.method !== "POST") {
      // Stateless mode: no SSE stream, no session teardown.
      return json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null },
        405
      );
    }

    if (authToken && request.headers.get("authorization") !== `Bearer ${authToken}`) {
      return json({ error: "Unauthorized" }, 401);
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, 400);
    }

    try {
      if (Array.isArray(body)) {
        const out: JSONRPCMessage[] = [];
        for (const m of body) {
          const r = await handleRpc(m);
          if (r) out.push(r);
        }
        return out.length ? json(out) : new Response(null, { status: 202 });
      }
      const result = await handleRpc(body);
      return result ? json(result) : new Response(null, { status: 202 });
    } catch (err) {
      console.error("MCP request failed:", err instanceof Error ? err.message : err);
      return json(
        {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: body?.id ?? null,
        },
        500
      );
    }
  },
};
