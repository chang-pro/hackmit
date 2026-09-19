// ReLoop MCP Catalog Server
//
// Exposes the ReLoop marketplace as a Model Context Protocol server so any
// MCP-compatible buyer agent (Claude, GPT, etc.) can discover listings,
// negotiate with the seller, and check out — all through the public API and
// without ever seeing the seller's floor price.
//
// Transport: HTTP/SSE (one endpoint pair for each connected agent session)
//   GET  /mcp/sse        — agent connects here, receives server-sent events
//   POST /mcp/messages   — agent sends tool calls and receives results here
//
// Tools exposed:
//   search_catalog  — browse active listings, filter by keyword
//   get_listing     — get full details on one listing
//   send_message    — send a plain message or a price offer to the seller
//   checkout        — complete the purchase once the seller has accepted
//
// Usage (standalone):
//   node services/market/mcp-catalog.js
//
// Usage (embedded in server.js — recommended):
//   import { createMcpCatalogServer } from "./services/market/mcp-catalog.js"
//   const mcpServer = createMcpCatalogServer({ market })
//   mcpServer.attach(httpServer, "/mcp")

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { createServer } from "node:http";

const MCP_PORT = Number(process.env.MCP_PORT ?? 3001);

// ── helpers ─────────────────────────────────────────────────────────────────

function catalogFromMarket(market) {
  return [...market.listings.values()]
    .filter((l) => l.status === "ACTIVE")
    .map((l) => market.publicListing(l));
}

// ── tool definitions ─────────────────────────────────────────────────────────

function registerTools(mcp, market) {
  // 1. search_catalog
  mcp.tool(
    "search_catalog",
    "Search the ReLoop store for secondhand items available to buy. Returns active listings with prices. Use this first to discover what's for sale.",
    {
      query: z
        .string()
        .optional()
        .describe(
          "Optional keyword to filter listings by title or description (case-insensitive). Omit to return all listings."
        ),
    },
    async ({ query }) => {
      const listings = catalogFromMarket(market);
      const filtered = query
        ? listings.filter(
            (l) =>
              l.title.toLowerCase().includes(query.toLowerCase()) ||
              (l.description ?? "").toLowerCase().includes(query.toLowerCase())
          )
        : listings;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                count: filtered.length,
                listings: filtered.map((l) => ({
                  id: l.id,
                  title: l.title,
                  condition: l.condition,
                  listUsd: l.listUsd,
                  description: l.description,
                  photoUrl: l.photoUrl ?? null,
                  shopifyUrl: l.shopify?.url ?? null,
                  marketplaceUrl: l.marketplace?.url ?? null,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 2. get_listing
  mcp.tool(
    "get_listing",
    "Get full details for a single listing by its ID, including current price and open negotiation threads.",
    {
      listing_id: z.string().describe("The listing ID from search_catalog (e.g. lst_demo_ps4)"),
    },
    async ({ listing_id }) => {
      const raw = market.listings.get(listing_id);
      if (!raw) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Listing ${listing_id} not found.` }) }],
          isError: true,
        };
      }
      const listing = market.publicListing(raw);
      return {
        content: [{ type: "text", text: JSON.stringify(listing, null, 2) }],
      };
    }
  );

  // 3. send_message
  mcp.tool(
    "send_message",
    "Send a message or price offer to the seller for a listing. The seller agent will reply automatically. " +
      "If you include price_usd, this is treated as an offer — the seller may counter, accept, or decline. " +
      "If no price_usd, it's a plain inquiry (e.g. 'Is this available?'). " +
      "You will receive a thread_id on the first message — pass it in subsequent messages to continue the same negotiation.",
    {
      listing_id: z.string().describe("The listing ID to send a message about"),
      text: z.string().describe("Your message text, e.g. 'Is this still available?' or 'I can offer $150.'"),
      price_usd: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Your offer price in USD (whole dollars). Omit for plain inquiries."),
      thread_id: z
        .string()
        .optional()
        .describe("Conversation thread ID from a prior send_message call. Omit on your first message."),
      buyer_name: z
        .string()
        .optional()
        .default("mcp-buyer")
        .describe("An identifier for you as the buyer (shown in logs, not to the seller)."),
    },
    async ({ listing_id, text, price_usd, thread_id, buyer_name }) => {
      try {
        const reply = market.message(listing_id, {
          threadId: thread_id ?? null,
          buyer: buyer_name ?? "mcp-buyer",
          text,
          priceUsd: price_usd ?? null,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  threadId: reply.threadId,
                  move: reply.move, // INFO | COUNTER | ACCEPT | REJECT
                  sellerText: reply.text,
                  sellerPriceUsd: reply.priceUsd ?? null,
                  listing: reply.listing,
                  hint:
                    reply.move === "ACCEPT"
                      ? "The seller accepted. Call checkout to complete the purchase."
                      : reply.move === "REJECT"
                      ? "The seller declined. No deal."
                      : reply.move === "COUNTER"
                      ? `The seller countered at $${reply.priceUsd}. You can accept with checkout or counter again with send_message.`
                      : null,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  // 4. checkout
  mcp.tool(
    "checkout",
    "Complete the purchase of a listing after the seller has accepted your price. " +
      "You must have a thread_id from a prior send_message where the seller's move was ACCEPT.",
    {
      listing_id: z.string().describe("The listing ID to purchase"),
      thread_id: z.string().describe("The thread ID from the accepted negotiation"),
    },
    async ({ listing_id, thread_id }) => {
      try {
        const result = market.checkout(listing_id, { threadId: thread_id });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  soldUsd: result.listing.soldUsd,
                  title: result.listing.title,
                  status: result.listing.status,
                  note: result.note,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    }
  );
}

// ── SSE transport factory ────────────────────────────────────────────────────

/**
 * Attach MCP SSE routes to an existing Node.js HTTP server.
 *
 *   GET  {prefix}/sse       — agent connects, receives SSE stream
 *   POST {prefix}/messages  — agent sends JSON-RPC messages
 *
 * @param {import("node:http").Server} httpServer
 * @param {object} market  - a Market instance
 * @param {string} [prefix="/mcp"]
 */
export function attachMcpToServer(httpServer, market, prefix = "/mcp") {
  const sessions = new Map(); // sessionId -> SSEServerTransport

  const origEmit = httpServer.emit.bind(httpServer);
  httpServer.on("request", (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === `${prefix}/sse`) {
      const mcp = new McpServer({
        name: "reloop-marketplace",
        version: "1.0.0",
      });
      registerTools(mcp, market);

      const transport = new SSEServerTransport(`${prefix}/messages`, res);
      sessions.set(transport.sessionId, transport);

      res.on("close", () => sessions.delete(transport.sessionId));
      mcp.connect(transport).catch(console.error);
      return;
    }

    if (req.method === "POST" && url.pathname === `${prefix}/messages`) {
      const sessionId = url.searchParams.get("sessionId");
      const transport = sessions.get(sessionId);
      if (!transport) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }
      transport.handlePostMessage(req, res);
      return;
    }
  });

  console.log(`[MCP] Catalog server attached at ${prefix}/sse (SSE transport)`);
  return sessions;
}

// ── standalone mode ─────────────────────────────────────────────────────────
// Run directly: node services/market/mcp-catalog.js
// Useful for connecting a desktop AI agent without starting the full server.

if (import.meta.url === `file://${process.argv[1]}`) {
  const { Market } = await import("./market.js");
  const { EventLog } = await import("../events/event-log.js");
  const { DraftQueue } = await import("./draft-queue.js");

  const eventLog = new EventLog();
  const draftQueue = new DraftQueue({ eventLog });
  const market = new Market({ eventLog, draftQueue });
  market.seedDemoData();

  const mcp = new McpServer({ name: "reloop-marketplace", version: "1.0.0" });
  registerTools(mcp, market);

  const httpServer = createServer();
  attachMcpToServer(httpServer, market, "/mcp");

  httpServer.listen(MCP_PORT, () => {
    console.log(`[MCP] ReLoop marketplace running on http://localhost:${MCP_PORT}/mcp/sse`);
    console.log(`      Connect your agent to: http://localhost:${MCP_PORT}/mcp/sse`);
    console.log(`      Active listings: ${[...market.listings.values()].filter(l => l.status === "ACTIVE").length}`);
  });
}
