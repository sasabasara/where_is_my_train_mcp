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

// Detect client type from user agent
function detectClientType(userAgent: string | undefined): string {
    if (!userAgent) return "unknown";
    if (userAgent.includes("curl")) return "curl";
    if (userAgent.includes("Claude") || userAgent.includes("claude")) return "claude-desktop";
    if (userAgent.includes("node") || userAgent.includes("undici")) return "mcp-client";
    if (userAgent.includes("Mozilla")) return "browser";
    return "unknown";
}

// Wide event logging middleware - one structured JSON per request
app.use((req, res, next) => {
    const startTime = Date.now();
    const requestId = randomUUID().slice(0, 8);

    // Capture the original json method
    const originalJson = res.json.bind(res);

    res.json = (body: any) => {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        const event = {
            // Request identity
            requestId,
            timestamp: new Date().toISOString(),

            // What happened
            method: req.method,
            path: req.path,
            mcpMethod: req.body?.method || null,
            mcpId: req.body?.id || null,
            toolName: req.body?.params?.name || null,
            toolArgs: req.body?.params?.arguments || null,

            // Who
            sessionId: sessionId?.slice(0, 8) || null,
            clientType: detectClientType(req.headers["user-agent"] as string),

            // Outcome
            statusCode: res.statusCode,
            success: res.statusCode < 400 && !body?.error,
            errorCode: body?.error?.code || null,
            errorMessage: body?.error?.message || null,

            // Performance
            durationMs: Date.now() - startTime,

            // Server context
            activeSessions: Object.keys(httpTransports).length
        };

        console.log(JSON.stringify(event));
        return originalJson(body);
    };

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
        // Extract client info from initialize request
        const clientInfo = req.body.params?.clientInfo;
        const clientName = clientInfo?.name || "unknown";
        const clientVersion = clientInfo?.version || "";
        const clientStr = clientVersion ? `${clientName} ${clientVersion}` : clientName;

        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (id) => {
                httpTransports[id] = transport;
                console.log(JSON.stringify({
                    event: "session_start",
                    timestamp: new Date().toISOString(),
                    sessionId: id.slice(0, 8),
                    clientName,
                    clientVersion,
                    activeSessions: Object.keys(httpTransports).length + 1
                }));
            }
        });

        transport.onclose = () => {
            if (transport.sessionId) {
                console.log(JSON.stringify({
                    event: "session_end",
                    timestamp: new Date().toISOString(),
                    sessionId: transport.sessionId.slice(0, 8),
                    activeSessions: Object.keys(httpTransports).length - 1
                }));
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
        // Return 405 Method Not Allowed per MCP spec when no valid session
        // This tells clients SSE is supported but requires a session first
        res.status(405).set("Allow", "POST, DELETE").json({
            jsonrpc: "2.0",
            error: { code: -32600, message: "SSE stream requires valid session. Initialize first with POST." },
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
    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : `http://localhost:${PORT}`;

    res.json({
        name: "where-is-my-train-mta",
        description: "NYC Subway MCP server providing real-time train arrivals, service alerts, and station information.",
        version: "1.0.0",
        url: baseUrl,
        homepage: "https://github.com/sasabasara/where_is_my_train_mcp",
        license: "MIT",
        transport: {
            type: "streamable-http",
            endpoint: `${baseUrl}/mcp`
        },
        authentication: {
            required: false
        },
        configSchema: {
            type: "object",
            properties: {},
            required: []
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
            ],
            prompts: [
                { name: "check_train_arrivals", description: "Check upcoming train arrivals at a station" },
                { name: "check_service_alerts", description: "Check current service alerts" },
                { name: "check_elevator_status", description: "Check elevator/escalator status" }
            ],
            resources: [
                { uri: "subway://lines", name: "Subway Lines", description: "List of all subway lines" },
                { uri: "subway://major-stations", name: "Major Stations", description: "List of major transfer stations" }
            ]
        }
    });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(JSON.stringify({
        event: "server_start",
        timestamp: new Date().toISOString(),
        port: PORT,
        version: "1.0.0"
    }));

    startPolling();

    ensureStationLineDataLoaded().then(() => {
        console.log(JSON.stringify({
            event: "gtfs_loaded",
            timestamp: new Date().toISOString(),
            success: true
        }));
    }).catch(err => {
        console.log(JSON.stringify({
            event: "gtfs_loaded",
            timestamp: new Date().toISOString(),
            success: false,
            error: err.message
        }));
    });
});
