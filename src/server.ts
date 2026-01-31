import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer } from "./index.js";
import { startPolling } from "./services/pollingService.js";
import { ensureStationLineDataLoaded } from "./services/gtfsLineResolver.js";
import { randomUUID } from "crypto";

const app = express();

// Store transports by session ID for multi-client support
const transports = new Map<string, SSEServerTransport>();

// Health check / root endpoint
app.get("/", (req, res) => {
    res.json({
        status: "ok",
        name: "nyc-subway-mcp",
        version: "1.0.0",
        endpoints: {
            sse: "/sse",
            messages: "/messages",
            serverCard: "/.well-known/mcp/server-card.json"
        }
    });
});

// MCP Server Card endpoint for Smithery discovery
app.get("/.well-known/mcp/server-card.json", (req, res) => {
    res.json({
        name: "nyc-subway",
        description: "Comprehensive NYC Subway assistant. USE GUIDELINES: 1. Use 'find_station' to map names to IDs. 2. Use 'next_trains' for real-time arrivals (data updates every 45s). 3. Use 'subway_alerts' for service delays and line-impact analysis. 4. Use 'nearest_station' for GPS-based discovery. 5. Follow up with 'station_transfers' for multi-leg trip planning.",
        version: "1.0.0",
        homepage: "https://github.com/sasabasara/where_is_my_train_mcp",
        license: "MIT",
        transport: {
            type: "sse",
            endpoint: "/sse"
        },
        authentication: {
            required: false
        },
        capabilities: {
            tools: [
                {
                    name: "find_station",
                    description: "Advanced station search with fuzzy matching, accessibility info, and nearby amenities"
                },
                {
                    name: "next_trains",
                    description: "Real-time train arrivals with delay predictions, crowding levels, and service alerts"
                },
                {
                    name: "service_status",
                    description: "Comprehensive service status with performance metrics, on-time rates, and system-wide health indicators"
                },
                {
                    name: "subway_alerts",
                    description: "Detailed service alerts with impact analysis, affected stations, and estimated resolution times"
                },
                {
                    name: "station_transfers",
                    description: "Find all train line transfer options at a specific subway station"
                },
                {
                    name: "nearest_station",
                    description: "Find closest subway stations with walking directions, accessibility info, and real-time service status"
                },
                {
                    name: "service_disruptions",
                    description: "Get comprehensive service disruption information with impact analysis, alternative routes, and estimated resolution times"
                },
                {
                    name: "elevator_and_escalator_status",
                    description: "Get current and upcoming elevator and escalator outages at subway stations, including ADA accessibility impact"
                }
            ],
            resources: [
                {
                    name: "subway_lines",
                    description: "NYC Subway Lines Reference with colors and divisions"
                },
                {
                    name: "major_stations",
                    description: "Major NYC Subway Transfer Stations"
                }
            ],
            prompts: [
                {
                    name: "check_train_arrivals",
                    description: "Check next trains arriving at a station"
                },
                {
                    name: "check_service_alerts",
                    description: "Check service alerts for a specific line or all lines"
                },
                {
                    name: "check_elevator_status",
                    description: "Check elevator status at a station"
                }
            ]
        }
    });
});

app.get("/sse", async (req, res) => {
    const sessionId = req.query.sessionId as string || randomUUID();
    console.log(`[SSE] New connection: ${sessionId}`);

    // Create a new server instance for this session
    const mcpServer = createMcpServer();

    // Create transport for this session
    const transport = new SSEServerTransport(`/messages?sessionId=${sessionId}`, res);

    // Store it
    transports.set(sessionId, transport);

    // Clean up on close
    res.on("close", () => {
        console.log(`[SSE] Connection closed: ${sessionId}`);
        transports.delete(sessionId);
    });

    await mcpServer.connect(transport);
});

app.post("/messages", express.json(), async (req, res) => {
    const sessionId = req.query.sessionId as string;

    if (!sessionId) {
        res.status(400).json({ error: "Missing sessionId parameter" });
        return;
    }

    const transport = transports.get(sessionId);

    if (transport) {
        await transport.handlePostMessage(req, res);
    } else {
        res.status(404).json({ error: "No active SSE connection for this session" });
    }
});

const PORT = process.env.PORT || 3000;

// Start Express server immediately to satisfy Railway's health checks
app.listen(PORT, () => {
    console.log(`[Server] MTA MCP Server running on port ${PORT}`);

    // Background tasks
    console.log('[Server] Starting background initialization...');

    // 1. Start background polling
    startPolling();

    // 2. Load station→lines mapping (heavy task, runs in background)
    ensureStationLineDataLoaded().then(() => {
        console.log('[Server] GTFS station-lines data loaded successfully.');
    }).catch(err => {
        console.error('[Server] Failed to load GTFS data:', err);
    });
});
