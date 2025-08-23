export const TOOL_DEFINITIONS = [
  {
    name: "gtfs_status",
    title: "GTFS Status",
    description: "Returns structured JSON data with GTFS cache status, data source information, and system health metrics. AI/LLM handles all formatting and presentation.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "service_disruptions",
    title: "Service Disruptions",
    description: "Returns structured JSON data with comprehensive service disruption information, impact analysis, and resolution times. AI/LLM handles all formatting and presentation.",
    inputSchema: {
      type: "object",
      properties: {
        line: {
          type: "string",
          description: "Optional: Filter by specific train line (1,2,3,4,5,6,7,A,B,C,D,E,F,G,J,L,M,N,Q,R,W,Z,S,SI)",
        },
        severity: {
          type: "string",
          enum: ["ALL", "CRITICAL", "MAJOR", "MINOR"],
          description: "Optional: Filter by disruption severity (default: ALL)",
        },
        location: {
          type: "string",
          description: "Optional: Filter disruptions affecting a specific area or station",
        },
      },
      required: [],
    },
  },
  {
    name: "find_station",
    title: "Find Station",
    description: "Returns structured JSON data with station search results, accessibility info, and nearby amenities. Supports fuzzy matching and partial names. AI/LLM handles all formatting and presentation.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Station name or partial name to search for (supports fuzzy matching)",
        },
        include_accessibility: {
          type: "boolean",
          description: "Optional: Include wheelchair accessibility information (default: false)",
        },
        include_amenities: {
          type: "boolean",
          description: "Optional: Include nearby amenities like restrooms, WiFi (default: false)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "next_trains",
    title: "Next Trains",
    description: "Returns structured JSON data with real-time train arrivals, timestamps, occupancy data, and service information. AI/LLM handles all formatting and presentation.",
    inputSchema: {
      type: "object",
      properties: {
        station: {
          type: "string",
          description: "Station name to get arrivals for (supports fuzzy matching)",
        },
        line: {
          type: "string",
          description: "Optional: Filter by specific train line (1,2,3,4,5,6,7,A,B,C,D,E,F,G,J,L,M,N,Q,R,W,Z,S,SI)",
        },
        direction: {
          type: "string",
          enum: ["uptown", "downtown", "manhattan", "brooklyn", "queens", "bronx"],
          description: "Optional: Filter by direction (context-aware based on station location)",
        },
        limit: {
          type: "number",
          description: "Optional: Maximum number of arrivals to return (default: 5, max: 10)",
        },
      },
      required: ["station"],
    },
  },
  {
    name: "service_status",
    title: "Service Status",
    description: "Returns structured JSON data with comprehensive service status, performance metrics, on-time rates, and system health indicators. AI/LLM handles all formatting and presentation.",
    inputSchema: {
      type: "object",
      properties: {
        line: {
          type: "string",
          description: "Optional: Filter by specific train line (1,2,3,4,5,6,7,A,B,C,D,E,F,G,J,L,M,N,Q,R,W,Z,S,SI)",
        },
        include_metrics: {
          type: "boolean",
          description: "Optional: Include performance metrics like on-time percentage (default: false)",
        },
        time_range: {
          type: "string",
          enum: ["current", "today", "week"],
          description: "Optional: Time range for status information (default: current)",
        },
      },
      required: [],
    },
  },
  {
    name: "subway_alerts",
    title: "Subway Alerts",
    description: "Returns structured JSON data with detailed service alerts, impact analysis, affected stations, active periods, and resolution times. AI/LLM handles all formatting and presentation.",
    inputSchema: {
      type: "object",
      properties: {
        line: {
          type: "string",
          description: "Optional: Filter alerts by specific train line (e.g., N, Q, R, W, 4, 5, 6, etc.)",
        },
        severity: {
          type: "string",
          enum: ["ALL", "CRITICAL", "MAJOR", "MINOR", "PLANNED"],
          description: "Optional: Filter by alert severity (default: ALL)",
        },
        category: {
          type: "string",
          enum: ["ALL", "DELAYS", "SUSPENSIONS", "REROUTES", "PLANNED_WORK", "ACCESSIBILITY"],
          description: "Optional: Filter by alert category (default: ALL)",
        },
        active_only: {
          type: "boolean",
          description: "Optional: Show only currently active alerts (default: true)",
        },
      },
      required: [],
    },
  },
  {
    name: "station_transfers",
    title: "Station Transfers",
    description: "Returns structured JSON data with all train line transfer options at a specific subway station, including connection details and transfer times. AI/LLM handles all formatting and presentation.",
    inputSchema: {
      type: "object",
      properties: {
        station: {
          type: "string",
          description: "Station name to find transfers for (e.g., 'Times Square', 'Union Square', 'Atlantic Ave')",
        },
      },
      required: ["station"],
    },
  },
  {
    name: "nearest_station",
    title: "Nearest Station",
    description: "Returns structured JSON data with closest subway stations, walking directions, accessibility info, and real-time service status. REQUIRES GPS coordinates (lat, lon). For location names like 'Prospect Park' or 'SoHo', AI/LLM should first convert to coordinates using geographic knowledge, then call this tool. AI/LLM handles all formatting and presentation.",
    inputSchema: {
      type: "object",
      properties: {
        lat: {
          type: "number",
          description: "Latitude coordinate (e.g., 40.7589 for Times Square). REQUIRED - AI must convert location names to coordinates first.",
        },
        lon: {
          type: "number",
          description: "Longitude coordinate (e.g., -73.9851 for Times Square). REQUIRED - AI must convert location names to coordinates first.",
        },
        limit: {
          type: "number",
          description: "Optional: Maximum number of stations to return (default: 5, max: 15)",
        },
        radius: {
          type: "number",
          description: "Optional: Search radius in meters (default: 1000m, max: 2000m)",
        },
        accessible_only: {
          type: "boolean",
          description: "Optional: Return only wheelchair accessible stations (default: false)",
        },
        include_walking_directions: {
          type: "boolean",
          description: "Optional: Include basic walking directions to stations (default: false)",
        },
        service_filter: {
          type: "array",
          items: { type: "string" },
          description: "Optional: Only return stations served by specific lines (e.g., ['4', '5', '6'])",
        },
      },
      required: ["lat", "lon"],
    },
  },
];
