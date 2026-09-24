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

import { ToolResponse } from "./types/index.js";

// Handlers wrap their JSON in `content[0].text`; when an outputSchema is declared
// the SDK also expects the parsed payload as `structuredContent`. Parse it once here.
function wrapHandlerResult(result: ToolResponse): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
} {
  const content = result.content.map((item) => ({ ...item, type: item.type as "text" }));
  const wrapped: ReturnType<typeof wrapHandlerResult> = { content };
  if (result.isError) wrapped.isError = result.isError;

  const text = result.content[0]?.text;
  if (text) {
    try {
      wrapped.structuredContent = JSON.parse(text);
    } catch {
      // Non-JSON text content (rare error path) — skip structuredContent
    }
  }
  return wrapped;
}

// Every handler returns this StandardResponse wrapper around a tool-specific `data`
const standardResponseShape = (dataSchema: z.ZodTypeAny) => ({
  status: z.enum(["success", "error"]),
  data: dataSchema,
  message: z.string(),
  metadata: z.object({ timestamp: z.number() })
});

// Tool-specific data shapes. All-optional + passthrough keeps the schema useful
// without breaking when handlers add fields or return error-shape data (null /
// {query} on failure).
const stationSummarySchema = z.object({
  name: z.string(),
  stopIds: z.array(z.string()),
  lines: z.array(z.string()),
  borough: z.string().nullable(),
  accessibility: z.enum(["full", "partial", "none"]).nullable(),
  accessibilityNotes: z.string().nullable()
}).passthrough();

const findStationOutputSchema = standardResponseShape(
  z.object({
    searchQuery: z.string().optional(),
    stationsFound: z.number().optional(),
    stations: z.array(stationSummarySchema).optional(),
    timestamp: z.number().optional(),
    query: z.string().optional()
  }).passthrough().nullable()
);

const nextTrainsOutputSchema = standardResponseShape(
  z.object({
    station: z.string().optional(),
    stopIds: z.array(z.string()).optional(),
    lines: z.array(z.string()).optional(),
    availableDirections: z.array(z.string()).optional(),
    note: z.string().optional(),
    arrivals: z.array(z.object({
      line: z.string().optional(),
      direction: z.string().nullable().optional(),
      destination: z.string().nullable().optional(),
      destinationBorough: z.string().nullable().optional(),
      arrivalTimestamp: z.number().nullable().optional(),
      station: z.string().optional(),
      stopId: z.string().optional(),
      tripId: z.string().optional()
    }).passthrough()).optional(),
    count: z.number().optional(),
    ambiguous: z.boolean().optional(),
    options: z.array(stationSummarySchema).optional(),
    unavailableFeeds: z.array(z.string()).optional(),
    query: z.string().optional()
  }).passthrough().nullable()
);

const severitySchema = z.enum(["CRITICAL", "MAJOR", "MINOR", "PLANNED"]);
const alertCategories = ["DELAYS", "SUSPENSIONS", "REROUTES", "PLANNED_WORK", "STATION_NOTICES", "OTHER"] as const;

const serviceStatusOutputSchema = standardResponseShape(
  z.object({
    line: z.string().nullable().optional(),
    activeTrips: z.number().optional(),
    activeAlerts: z.number().optional(),
    topAlerts: z.array(z.object({
      header: z.string(),
      severity: severitySchema,
      alertType: z.string().nullable(),
      affectedLines: z.array(z.string())
    }).passthrough()).optional(),
    unavailableFeeds: z.array(z.string()).optional()
  }).passthrough().nullable()
);

const subwayAlertsOutputSchema = standardResponseShape(
  z.object({
    total: z.number(),
    returned: z.number(),
    alerts: z.array(z.object({
      header: z.string(),
      description: z.string().nullable(),
      alertType: z.string().nullable(),
      severity: severitySchema,
      category: z.enum(alertCategories),
      affectedLines: z.array(z.string()),
      isActive: z.boolean(),
      activePeriod: z.object({ start: z.number(), end: z.number().nullable() }).nullable(),
      updatedAt: z.number().nullable()
    }).passthrough())
  }).passthrough().nullable()
);

const stationTransfersOutputSchema = standardResponseShape(
  z.object({
    station: z.string().optional(),
    lines: z.array(z.string()).optional(),
    connections: z.array(z.object({
      name: z.string(),
      stopId: z.string(),
      lines: z.array(z.string())
    })).optional(),
    query: z.string().optional()
  }).passthrough().nullable()
);

const nearestStationOutputSchema = standardResponseShape(
  z.array(z.object({
    name: z.string(),
    stopId: z.string(),
    distance: z.number(),
    coordinates: z.object({ lat: z.number(), lon: z.number() })
  }).passthrough()).nullable()
);

const serviceDisruptionsOutputSchema = standardResponseShape(
  z.object({
    timestamp: z.number().optional(),
    timezone: z.string().optional(),
    filteredLine: z.string().nullable().optional(),
    filteredLocation: z.string().nullable().optional(),
    filteredSeverity: z.string().nullable().optional(),
    systemStatus: z.enum(["normal", "service_changes", "disrupted"]).optional(),
    counts: z.object({
      total: z.number(),
      critical: z.number(),
      major: z.number(),
      minor: z.number(),
      planned: z.number()
    }).optional(),
    disruptions: z.array(z.unknown()).optional(),
    serviceNote: z.string().nullable().optional()
  }).passthrough().nullable()
);

const elevatorEscalatorOutputSchema = standardResponseShape(
  z.object({
    total: z.number(),
    returned: z.number(),
    outages: z.array(z.object({
      station: z.string(),
      lines: z.string(),
      equipment: z.enum(["Elevator", "Escalator"]),
      equipmentId: z.string(),
      serving: z.string(),
      ada: z.boolean(),
      status: z.enum(["Upcoming Work", "Currently Out"]),
      reason: z.string(),
      outageStart: z.string(),
      estimatedReturn: z.string().nullable(),
      alternativeRoute: z.string().nullable()
    }).passthrough())
  }).passthrough().nullable()
);

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
    // Handlers wrap their payload as { status, data, message }
    const parsed = JSON.parse(text);
    const data = parsed.data;

    let summary = "";
    if (parsed.status === "error") summary = `error: ${parsed.message}`;
    else if (Array.isArray(data)) summary = `${data.length} result(s)`;
    else if (data?.ambiguous) summary = `ambiguous: ${data.options.length} station(s)`;
    else if (data?.stations) summary = `${data.stations.length} station(s)`;
    else if (data?.arrivals) summary = `${data.arrivals.length} arrival(s)`;
    else if (data?.alerts) summary = `${data.total} alert(s)`;
    else if (data?.disruptions) summary = `${data.systemStatus}, ${data.disruptions.length} disruption(s)`;
    else if (data?.outages) summary = `${data.total} outage(s)`;
    else if (data?.connections) summary = `${data.lines.length} line(s)`;
    else if (data?.activeTrips !== undefined) summary = `${data.activeTrips} trip(s), ${data.activeAlerts} alert(s)`;
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
      description: "Search for subway stations by name. Returns one entry per station complex with its stop IDs (usable as next_trains stop_id), daytime lines, borough, and wheelchair accessibility",
      inputSchema: {
        query: z.string().describe("Station name or partial name to search for")
      },
      outputSchema: findStationOutputSchema,
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
      description: "Real-time train arrivals at a station from live MTA feeds: line, direction (the MTA platform label, e.g. \"Uptown\", \"Manhattan\", \"Coney Island\"), destination, and predicted arrival time (Unix ms). Trains that end their run at the station are excluded. If a name matches several different stations (e.g. \"23 St\"), returns ambiguous=true with options instead of arrivals — ask the rider which one, then call again with stop_id",
      inputSchema: {
        station: z.string().optional().describe("Station name to get arrivals for"),
        stop_id: z.string().optional().describe("GTFS stop ID from find_station/nearest_station (e.g. \"635\"); takes precedence over station"),
        direction: z.string().optional().describe("Direction as riders say it: \"uptown\", \"downtown\", \"manhattan\", \"brooklyn\", \"queens\", \"bronx\", a terminal like \"coney island\", or \"north\"/\"south\". Matched against the MTA platform label, the train's destination, and the destination's borough"),
        limit: z.number().optional().describe("Maximum number of arrivals to return (1-10, default 5)"),
        line: z.string().optional().describe("Filter by line, e.g. \"6\" (includes 6X express), \"S\" for shuttles")
      },
      outputSchema: nextTrainsOutputSchema,
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
      description: "Quick service snapshot for the whole system or one line: number of trains currently running, number of alerts in effect, the 3 most severe alerts, and any real-time feeds that are currently unavailable",
      inputSchema: {
        line: z.string().optional().describe("Limit to one line, e.g. \"L\" or \"6\"")
      },
      outputSchema: serviceStatusOutputSchema,
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
      description: "Official MTA subway service alerts, most severe first. Each alert includes the MTA alert type (e.g. \"Delays\", \"Part Suspended\", \"Planned - Stops Skipped\"), severity, category, affected lines, and active period (Unix ms). Only alerts in effect right now by default; set active_only=false to include upcoming planned work",
      inputSchema: {
        line: z.string().optional().describe("Filter alerts by specific train line"),
        active_only: z.boolean().optional().describe("Only alerts in effect right now (default: true)"),
        category: z.enum(["ALL", ...alertCategories]).optional().describe("Filter by alert category"),
        severity: z.enum(["ALL", "CRITICAL", "MAJOR", "MINOR", "PLANNED"]).optional().describe("Filter by alert severity")
      },
      outputSchema: subwayAlertsOutputSchema,
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
      description: "Lines a rider can reach at a station without leaving the system: all daytime lines at the station complex, and each connected platform with its lines",
      inputSchema: {
        station: z.string().describe("Station name to find transfers for")
      },
      outputSchema: stationTransfersOutputSchema,
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
      description: "Find the subway stations closest to GPS coordinates, sorted by straight-line distance in meters, with daytime lines and wheelchair accessibility. Requires lat/lon — convert addresses or landmarks to coordinates first",
      inputSchema: {
        lat: z.number().optional().describe("Latitude coordinate (required)"),
        lon: z.number().optional().describe("Longitude coordinate (required)"),
        limit: z.number().optional().describe("Maximum number of stations to return (1-20, default 5)"),
        radius: z.number().optional().describe("Search radius in meters"),
        accessible_only: z.boolean().optional().describe("Only stations with full or partial wheelchair access (check accessibilityNotes for partial)"),
        service_filter: z.array(z.string()).optional().describe("Only stations served by any of these lines (daytime service)")
      },
      outputSchema: nearestStationOutputSchema,
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
      description: "Is subway service disrupted right now? Summarizes alerts in effect for the system, one line, or a location: overall status (normal / service_changes / disrupted), counts by severity, and each disruption with affected lines, affected stations, and when it is expected to end (Unix ms, when known)",
      inputSchema: {
        line: z.string().optional().describe("Filter by specific train line"),
        location: z.string().optional().describe("Filter disruptions affecting a specific area or station"),
        severity: z.enum(["ALL", "CRITICAL", "MAJOR", "MINOR", "PLANNED"]).optional().describe("Filter by disruption severity")
      },
      outputSchema: serviceDisruptionsOutputSchema,
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
      description: "Elevator and escalator outages at subway stations. Each outage includes station, lines, what the equipment serves, ADA status, reason, outage start and estimated return (New York local time), and the MTA's suggested alternative route when one exists",
      inputSchema: {
        station: z.string().optional().describe("Filter by station name (supports partial matching)"),
        equipment_type: z.enum(["elevator", "escalator", "all"]).optional().describe("Filter by equipment type (default: all)"),
        ada_only: z.boolean().optional().describe("Show only ADA-accessible equipment (default: false)"),
        outage_type: z.enum(["current", "upcoming", "all"]).optional().describe("Filter by outage timing (default: current)")
      },
      outputSchema: elevatorEscalatorOutputSchema,
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

