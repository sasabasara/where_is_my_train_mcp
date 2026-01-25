import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer } from "./index.js";
import { startPolling } from "./services/pollingService.js";
import { ensureStationLineDataLoaded } from "./services/gtfsLineResolver.js";
import { randomUUID } from "crypto";

const app = express();

// Store transports by session ID for multi-client support
const transports = new Map<string, SSEServerTransport>();

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
