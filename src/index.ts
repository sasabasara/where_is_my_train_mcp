// import { config } from 'dotenv'; // Removed - using Smithery config
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { 
  handleFindStation,
  handleNextTrains,
  handleServiceStatus,
  handleSubwayAlerts,
  handleStationTransfers,
  handleNearestStation,
  handleServiceDisruptions
} from "./handlers/toolHandlers.js";
import { loadStaticGTFS } from "./services/stationService.js";


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

// Load environment variables (commented out - using Smithery config)
// config();

// Note: Environment validation removed - using Smithery config for API keys
// GTFS loading is handled by individual services as needed

// Optional: Define configuration schema (empty for now since no config needed)
export const configSchema = z.object({});

export default function ({ config }: { config: z.infer<typeof configSchema> }) {
  // GTFS data will be loaded lazily when first tool is called

  const server = new McpServer({
    name: 'whereismytrain',
    version: '1.0.0'
  });

 


  server.registerTool(
    "find_station",
    {
      title: "Find Station",
      description: "Advanced station search with fuzzy matching, accessibility info, and nearby amenities",
      inputSchema: {
        query: z.string().describe("Station name or partial name to search for"),
        include_accessibility: z.boolean().optional().describe("Include wheelchair accessibility information"),
        include_amenities: z.boolean().optional().describe("Include nearby amenities like restrooms, WiFi")
      }
    },
    async (args) => {
      try {
        const result = await handleFindStation(args);
        return wrapHandlerResult(result);
      } catch (error) {
        console.error('Find Station tool error occurred');
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
      }
    },
    async (args) => {
      try {
        const result = await handleNextTrains(args);
        return wrapHandlerResult(result);
      } catch (error) {
        console.error('Next Trains tool error occurred');
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
      }
    },
    async (args) => {
      try {
        const result = await handleServiceStatus(args);
        return wrapHandlerResult(result);
      } catch (error) {
        console.error('Service Status tool error occurred');
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
      }
    },
    async (args) => {
      try {
        const result = await handleSubwayAlerts(args);
        return wrapHandlerResult(result);
      } catch (error) {
        console.error('Subway Alerts tool error occurred');
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
      }
    },
    async (args) => {
      try {
        const result = await handleStationTransfers(args);
        return wrapHandlerResult(result);
      } catch (error) {
        console.error('Station Transfers tool error occurred');
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
      description: "Find closest subway stations with walking directions, accessibility info, and real-time service status",
      inputSchema: {
        location: z.string().optional().describe("Address, landmark, or neighborhood"),
        lat: z.number().optional().describe("Latitude coordinate"),
        lon: z.number().optional().describe("Longitude coordinate"),
        limit: z.number().optional().describe("Maximum number of stations to return"),
        radius: z.number().optional().describe("Search radius in meters"),
        accessible_only: z.boolean().optional().describe("Return only wheelchair accessible stations"),
        include_walking_directions: z.boolean().optional().describe("Include basic walking directions to stations"),
        service_filter: z.array(z.string()).optional().describe("Only return stations served by specific lines")
      }
    },
    async (args) => {
      try {
        const result = await handleNearestStation(args);
        return wrapHandlerResult(result);
      } catch (error) {
        console.error('Nearest Station tool error occurred');
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
      }
    },
    async (args) => {
      try {
        const result = await handleServiceDisruptions(args);
        return wrapHandlerResult(result);
      } catch (error) {
        console.error('Service Disruptions tool error occurred');
        return {
          content: [{ type: "text" as const, text: "Service disruption data temporarily unavailable. Please try again later." }],
          isError: true
        };
      }
    }
  );

  return server;
}

