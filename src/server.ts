import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer } from "./index.js";
import { startPolling } from "./services/pollingService.js";
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

app.post("/messages", async (req, res) => {
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

app.listen(PORT, () => {
    console.log(`MCP Server running on port ${PORT}`);
    startPolling(); // Start the background polling
});
