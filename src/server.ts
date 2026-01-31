import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./index.js";
import { startPolling } from "./services/pollingService.js";
import { ensureStationLineDataLoaded } from "./services/gtfsLineResolver.js";
import { randomUUID } from "crypto";

const app = express();

// Parse JSON bodies for all routes
app.use(express.json());

// CORS middleware for cross-origin clients
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, mcp-protocol-version");
    res.header("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") {
        res.sendStatus(200);
        return;
    }
    next();
});

// Store Streamable HTTP transports by session ID
const httpTransports: Record<string, StreamableHTTPServerTransport> = {};

// Health check / root endpoint
app.get("/", (req, res) => {
    res.json({
        status: "ok",
        name: "where-is-my-train-mta",
        version: "1.0.0",
        endpoints: {
            mcp: "/mcp",
            serverCard: "/.well-known/mcp/server-card.json"
        }
    });
});

// Streamable HTTP transport (POST /mcp)
app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && httpTransports[sessionId]) {
        transport = httpTransports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (id) => {
                httpTransports[id] = transport;
                console.log(`[MCP] Session initialized: ${id}`);
            }
        });

        transport.onclose = () => {
            if (transport.sessionId) {
                console.log(`[MCP] Session closed: ${transport.sessionId}`);
                delete httpTransports[transport.sessionId];
            }
        };

        const mcpServer = createMcpServer();
        await mcpServer.connect(transport);
    } else {
        res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: No valid session or initialize request" },
            id: null
        });
        return;
    }

    await transport.handleRequest(req, res, req.body);
});

// Streamable HTTP transport (GET /mcp for SSE notifications)
app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    const transport = httpTransports[sessionId];

    if (transport) {
        await transport.handleRequest(req, res);
    } else {
        res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Invalid session" },
            id: null
        });
    }
});

// Streamable HTTP transport (DELETE /mcp for session termination)
app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    const transport = httpTransports[sessionId];

    if (transport) {
        await transport.handleRequest(req, res);
    } else {
        res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Invalid session" },
            id: null
        });
    }
});

// MCP Server Card endpoint for discovery
app.get("/.well-known/mcp/server-card.json", (req, res) => {
    res.json({
        name: "where-is-my-train-mta",
        description: "NYC Subway MCP server providing real-time train arrivals, service alerts, and station information.",
        version: "1.0.0",
        homepage: "https://github.com/sasabasara/where_is_my_train_mcp",
        license: "MIT",
        transport: {
            type: "http",
            endpoint: "/mcp"
        },
        authentication: {
            required: false
        },
        capabilities: {
            tools: [
                { name: "find_station", description: "Search for subway stations by name" },
                { name: "next_trains", description: "Get real-time train arrivals" },
                { name: "service_status", description: "Get service status for subway lines" },
                { name: "subway_alerts", description: "Get service alerts and delays" },
                { name: "station_transfers", description: "Find transfer options at a station" },
                { name: "nearest_station", description: "Find closest subway stations" },
                { name: "service_disruptions", description: "Get service disruption information" },
                { name: "elevator_and_escalator_status", description: "Get elevator/escalator outage info" }
            ]
        }
    });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`[Server] NYC Subway MCP Server running on port ${PORT}`);
    console.log('[Server] Starting background initialization...');

    startPolling();

    ensureStationLineDataLoaded().then(() => {
        console.log('[Server] GTFS station-lines data loaded successfully.');
    }).catch(err => {
        console.error('[Server] Failed to load GTFS data:', err);
    });
});
