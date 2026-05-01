import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  handleFindStation,
  handleNextTrains,
  handleServiceStatus,
  handleSubwayAlerts,
  handleStationTransfers,
  handleNearestStation,
  handleServiceDisruptions,
  handleElevatorEscalatorStatus
} from "./handlers/toolHandlers.js";

// Type-safe wrapper for handler results
type HandlerResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

import { ToolResponse } from "./types/index.js";

function wrapHandlerResult(result: ToolResponse): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  return {
    content: result.content.map((item) => ({ ...item, type: item.type as "text" })),
    ...(result.isError && { isError: result.isError })
  };
}

// Tool logging helper
function logToolCall(toolName: string, args: Record<string, unknown>): void {
  const argsStr = Object.entries(args)
    .filter(([_, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(", ");
  console.log(`[Tool] ${toolName} called: { ${argsStr} }`);
}

function logToolResult(toolName: string, result: ToolResponse): void {
  try {
    const text = result.content[0]?.text;
    if (!text) {
      console.log(`[Tool] ${toolName} completed: empty response`);
      return;
    }
    const parsed = JSON.parse(text);

    // Generate a summary based on common response patterns
    let summary = "";
    if (parsed.stations) summary = `${parsed.stations.length} station(s)`;
    else if (parsed.arrivals) summary = `${parsed.arrivals.length} arrival(s)`;
    else if (parsed.alerts) summary = `${parsed.alerts.length} alert(s)`;
    else if (parsed.disruptions) summary = `${parsed.disruptions.length} disruption(s)`;
    else if (parsed.lines) summary = `${parsed.lines.length} line(s)`;
    else if (parsed.outages) summary = `${parsed.outages.length} outage(s)`;
    else if (parsed.errorType) summary = `error: ${parsed.errorType}`;
    else summary = "ok";

    console.log(`[Tool] ${toolName} completed: ${summary}`);
  } catch {
    console.log(`[Tool] ${toolName} completed`);
  }
}

export function createMcpServer() {
  // GTFS data will be loaded lazily when first tool is called (stdio mode)
  // Railway server preloads this data at startup for better performance

  const server = new McpServer({
    name: 'where-is-my-train-mta',
    version: '1.0.0'
  });

  // Subway line data for resources
  const subwayLines = [
    { id: "1", name: "1", color: "#EE352E", division: "IRT" },
    { id: "2", name: "2", color: "#EE352E", division: "IRT" },
    { id: "3", name: "3", color: "#EE352E", division: "IRT" },
    { id: "4", name: "4", color: "#00933C", division: "IRT" },
    { id: "5", name: "5", color: "#00933C", division: "IRT" },
    { id: "6", name: "6", color: "#00933C", division: "IRT" },
    { id: "7", name: "7", color: "#B933AD", division: "IRT" },
    { id: "A", name: "A", color: "#0039A6", division: "IND" },
    { id: "C", name: "C", color: "#0039A6", division: "IND" },
    { id: "E", name: "E", color: "#0039A6", division: "IND" },
    { id: "B", name: "B", color: "#FF6319", division: "IND" },
    { id: "D", name: "D", color: "#FF6319", division: "IND" },
    { id: "F", name: "F", color: "#FF6319", division: "IND" },
    { id: "M", name: "M", color: "#FF6319", division: "IND" },
    { id: "G", name: "G", color: "#6CBE45", division: "IND" },
    { id: "J", name: "J", color: "#996633", division: "BMT" },
    { id: "Z", name: "Z", color: "#996633", division: "BMT" },
    { id: "L", name: "L", color: "#A7A9AC", division: "BMT" },
    { id: "N", name: "N", color: "#FCCC0A", division: "BMT" },
    { id: "Q", name: "Q", color: "#FCCC0A", division: "BMT" },
    { id: "R", name: "R", color: "#FCCC0A", division: "BMT" },
    { id: "W", name: "W", color: "#FCCC0A", division: "BMT" },
    { id: "S", name: "S (42nd St Shuttle)", color: "#808183", division: "Shuttle" },
    { id: "SI", name: "Staten Island Railway", color: "#0039A6", division: "SIR" }
  ];

  // Register Resources
  server.registerResource(
    "subway_lines",
    "subway://lines",
    { description: "NYC Subway Lines Reference", mimeType: "application/json" },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({
          description: "NYC Subway Lines Reference",
          lastUpdated: new Date().toISOString(),
          lines: subwayLines
        })
      }]
    })
  );

  server.registerResource(
    "major_stations",
    "subway://major-stations",
    { description: "Major NYC Subway Transfer Stations", mimeType: "application/json" },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({
          description: "Major NYC Subway Transfer Stations",
          stations: [
            { name: "Times Sq-42 St", lines: ["1", "2", "3", "7", "N", "Q", "R", "W", "S"], borough: "Manhattan" },
            { name: "34 St-Herald Sq", lines: ["B", "D", "F", "M", "N", "Q", "R", "W"], borough: "Manhattan" },
            { name: "14 St-Union Sq", lines: ["4", "5", "6", "L", "N", "Q", "R", "W"], borough: "Manhattan" },
            { name: "Atlantic Av-Barclays Ctr", lines: ["2", "3", "4", "5", "B", "D", "N", "Q", "R"], borough: "Brooklyn" },
            { name: "Fulton St", lines: ["2", "3", "4", "5", "A", "C", "J", "Z"], borough: "Manhattan" },
            { name: "Jay St-MetroTech", lines: ["A", "C", "F", "R"], borough: "Brooklyn" },
            { name: "59 St-Columbus Circle", lines: ["1", "A", "B", "C", "D"], borough: "Manhattan" },
            { name: "Grand Central-42 St", lines: ["4", "5", "6", "7", "S"], borough: "Manhattan" },
            { name: "Chambers St", lines: ["1", "2", "3", "A", "C"], borough: "Manhattan" },
            { name: "Broadway Junction", lines: ["A", "C", "J", "Z", "L"], borough: "Brooklyn" }
          ]
        })
      }]
    })
  );

  // Register Prompts
  server.registerPrompt(
    "check_train_arrivals",
    {
      description: "Check upcoming train arrivals at a station",
      argsSchema: { station: z.string().describe("Station name to check") }
    },
    ({ station }) => ({
      messages: [{
        role: "user",
        content: { type: "text", text: `What are the next trains arriving at ${station}?` }
      }]
    })
  );

  server.registerPrompt(
    "check_service_alerts",
    {
      description: "Check current subway service alerts",
      argsSchema: { line: z.string().optional().describe("Subway line to check (optional)") }
    },
    ({ line }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text", text: line
            ? `Are there any service alerts for the ${line} train?`
            : `Are there any subway service alerts right now?`
        }
      }]
    })
  );

  server.registerPrompt(
    "check_elevator_status",
    {
      description: "Check elevator and escalator status at a station",
      argsSchema: { station: z.string().describe("Station to check elevator status") }
    },
    ({ station }) => ({
      messages: [{
        role: "user",
        content: { type: "text", text: `Are the elevators working at ${station}?` }
      }]
    })
  );

  // Register Tools with Annotations

  server.registerTool(
    "find_station",
    {
      title: "Find Station",
      description: "Search for subway stations by name with fuzzy matching and relevance scoring",
      inputSchema: {
        query: z.string().describe("Station name or partial name to search for")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      logToolCall("find_station", args);
      try {
        const result = await handleFindStation(args);
        logToolResult("find_station", result);
        return wrapHandlerResult(result);
      } catch (error) {
        console.error('[Tool] find_station error');
        return {
          content: [{ type: "text" as const, text: "Station search temporarily unavailable. Please try again later." }],
          isError: true
        };
      }
    }
  );

  server.registerTool(
    "next_trains",
    {
      title: "Next Trains",
      description: "Real-time train arrivals with delay predictions, crowding levels, and service alerts",
      inputSchema: {
        station: z.string().describe("Station name to get arrivals for"),
        direction: z.enum(["uptown", "downtown", "manhattan", "brooklyn", "queens", "bronx"]).optional().describe("Filter by direction"),
        limit: z.number().optional().describe("Maximum number of arrivals to return"),
        line: z.string().optional().describe("Filter by specific train line")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (args) => {
      logToolCall("next_trains", args);
      try {
        const result = await handleNextTrains(args);
        logToolResult("next_trains", result);
        return wrapHandlerResult(result);
      } catch (error) {
        console.error('[Tool] next_trains error');
        return {
          content: [{ type: "text" as const, text: "Train arrival data temporarily unavailable. Please try again later." }],
          isError: true
        };
      }
    }
  );

  server.registerTool(
    "service_status",
    {
      title: "Service Status",
      description: "Comprehensive service status with performance metrics, on-time rates, and system-wide health indicators",
      inputSchema: {
        line: z.string().optional().describe("Filter by specific train line"),
        include_metrics: z.boolean().optional().describe("Include performance metrics like on-time percentage"),
        time_range: z.enum(["current", "today", "week"]).optional().describe("Time range for status information")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (args) => {
      logToolCall("service_status", args);
      try {
        const result = await handleServiceStatus(args);
        logToolResult("service_status", result);
        return wrapHandlerResult(result);
      } catch (error) {
        console.error('[Tool] service_status error');
        return {
          content: [{ type: "text" as const, text: "Service status temporarily unavailable. Please try again later." }],
          isError: true
        };
      }
    }
  );

  server.registerTool(
    "subway_alerts",
    {
      title: "Subway Alerts",
      description: "Detailed service alerts with impact analysis, affected stations, and estimated resolution times",
      inputSchema: {
        line: z.string().optional().describe("Filter alerts by specific train line"),
        active_only: z.boolean().optional().describe("Show only currently active alerts"),
        category: z.enum(["ALL", "DELAYS", "SUSPENSIONS", "REROUTES", "PLANNED_WORK", "ACCESSIBILITY"]).optional().describe("Filter by alert category"),
        severity: z.enum(["ALL", "CRITICAL", "MAJOR", "MINOR", "PLANNED"]).optional().describe("Filter by alert severity")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (args) => {
      logToolCall("subway_alerts", args);
      try {
        const result = await handleSubwayAlerts(args);
        logToolResult("subway_alerts", result);
        return wrapHandlerResult(result);
      } catch (error) {
        console.error('[Tool] subway_alerts error');
        return {
          content: [{ type: "text" as const, text: "Subway alerts temporarily unavailable. Please try again later." }],
          isError: true
        };
      }
    }
  );

  server.registerTool(
    "station_transfers",
    {
      title: "Station Transfers",
      description: "Find all train line transfer options at a specific subway station",
      inputSchema: {
        station: z.string().describe("Station name to find transfers for")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      logToolCall("station_transfers", args);
      try {
        const result = await handleStationTransfers(args);
        logToolResult("station_transfers", result);
        return wrapHandlerResult(result);
      } catch (error) {
        console.error('[Tool] station_transfers error');
        return {
          content: [{ type: "text" as const, text: "Station transfer data temporarily unavailable. Please try again later." }],
          isError: true
        };
      }
    }
  );

  server.registerTool(
    "nearest_station",
    {
      title: "Nearest Station",
      description: "Find closest subway stations by distance with accessibility info and real-time service status",
      inputSchema: {
        location: z.string().optional().describe("Address, landmark, or neighborhood"),
        lat: z.number().optional().describe("Latitude coordinate"),
        lon: z.number().optional().describe("Longitude coordinate"),
        limit: z.number().optional().describe("Maximum number of stations to return"),
        radius: z.number().optional().describe("Search radius in meters"),
        accessible_only: z.boolean().optional().describe("Return only wheelchair accessible stations"),
        service_filter: z.array(z.string()).optional().describe("Only return stations served by specific lines")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      logToolCall("nearest_station", args);
      try {
        const result = await handleNearestStation(args);
        logToolResult("nearest_station", result);
        return wrapHandlerResult(result);
      } catch (error) {
        console.error('[Tool] nearest_station error');
        return {
          content: [{ type: "text" as const, text: "Nearest station search temporarily unavailable. Please try again later." }],
          isError: true
        };
      }
    }
  );


  server.registerTool(
    "service_disruptions",
    {
      title: "Service Disruptions",
      description: "Get comprehensive service disruption information with impact analysis, alternative routes, and estimated resolution times",
      inputSchema: {
        line: z.string().optional().describe("Filter by specific train line"),
        location: z.string().optional().describe("Filter disruptions affecting a specific area or station"),
        severity: z.enum(["ALL", "CRITICAL", "MAJOR", "MINOR"]).optional().describe("Filter by disruption severity")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (args) => {
      logToolCall("service_disruptions", args);
      try {
        const result = await handleServiceDisruptions(args);
        logToolResult("service_disruptions", result);
        return wrapHandlerResult(result);
      } catch (error) {
        console.error('[Tool] service_disruptions error');
        return {
          content: [{ type: "text" as const, text: "Service disruption data temporarily unavailable. Please try again later." }],
          isError: true
        };
      }
    }
  );

  server.registerTool(
    "elevator_and_escalator_status",
    {
      title: "Elevator and Escalator Status",
      description: "Get current and upcoming elevator and escalator outages at subway stations, including ADA accessibility impact and estimated return to service",
      inputSchema: {
        station: z.string().optional().describe("Filter by station name (supports partial matching)"),
        equipment_type: z.enum(["elevator", "escalator", "all"]).optional().describe("Filter by equipment type (default: all)"),
        ada_only: z.boolean().optional().describe("Show only ADA-accessible equipment (default: false)"),
        outage_type: z.enum(["current", "upcoming", "all"]).optional().describe("Filter by outage timing (default: current)")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (args) => {
      logToolCall("elevator_and_escalator_status", args);
      try {
        const result = await handleElevatorEscalatorStatus(args);
        logToolResult("elevator_and_escalator_status", result);
        return wrapHandlerResult(result);
      } catch (error) {
        console.error('[Tool] elevator_and_escalator_status error');
        return {
          content: [{ type: "text" as const, text: "Elevator and escalator status temporarily unavailable. Please try again later." }],
          isError: true
        };
      }
    }
  );

  return server;
}

