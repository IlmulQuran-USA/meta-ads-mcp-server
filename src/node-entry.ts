/**
 * Node entry point — stdio (local Claude Desktop) or express HTTP.
 * Cloudflare Workers uses src/worker.ts instead.
 */
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import { server, PORTFOLIO_ALIASES } from "./index.js";

async function runStdio(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error("meta-ads-mcp-server v3 on stdio");
}

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
    if (hits.size > 10_000) hits.clear();
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
    res.json({ ok: true, version: "3.0.0", portfolios: PORTFOLIO_ALIASES });
  });

  app.post(mcpPath, async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    const ip = req.ip || "unknown";
    if (!allowed(ip)) {
      res.status(429).json({ error: "Rate limit exceeded (60 req/min per IP)" });
      return;
    }
    if (authToken) {
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
    console.error(
      `meta-ads-mcp-server v3 on :${port}${pathSecret ? "/mcp/<secret>" : "/mcp"} | portfolios: ${PORTFOLIO_ALIASES.join(", ")} | header-auth: ${authToken ? "ON" : "OFF"}`
    );
  });
}

((process.env.TRANSPORT || "http") === "stdio" ? runStdio : runHttp)().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
