# Where's My Train? MCP Server

[![smithery badge](https://smithery.ai/badge/@sasabasara/where_is_my_train_mcp)](https://smithery.ai/server/@sasabasara/where_is_my_train_mcp)

A Model Context Protocol (MCP) server that provides real-time NYC subway information. It leverages AI and LLM geographic knowledge for intelligent location handling and provides structured JSON data for stations, arrivals, alerts, and service status using live MTA data.

> **Data from MTA** - Personal use only - Not endorsed by MTA - Data provided "as is"

## Features

- **Real-time train arrivals**: Arrival times, delay predictions, and crowding information.
- **Station search**: Fuzzy matching and accessibility information.
- **Service alerts**: Disruption analysis and service changes.
- **Elevator & Escalator status**: Live outage information for accessibility planning.
- **Intelligent location handling**: Converts location names to coordinates for spatial searches.
- **Transfer information**: Connection details for complex routes.
- **Live MTA GTFS-RT data**: Covers all subway lines.

## Usage

### Option 1: Use on Smithery (Recommended)

Visit the [Smithery page](https://smithery.ai/server/@sasabasara/where_is_my_train_mcp) and click "Install" to add it to your AI client. No separate setup is required.

### Option 2: Run Locally

**Prerequisites:**
- Node.js 18+

**Quick Start:**

```bash
# Clone and install
git clone <your-repo>
cd whereismytrain-mcp
npm install

# Start development server
npm run dev

# Or start traditional MCP server
npm start
```

The server automatically downloads and caches MTA GTFS data on the first run.

## Capabilities

### Tools

#### Core Tools
- `next_trains`: Get real-time arrivals with crowding indicators.
- `find_station`: Search for stations using name or partial match.
- `nearest_station`: Find closest stations using GPS coordinates.
- `station_transfers`: List transfer options at specific stations.

#### System Tools
- `service_status`: Check system-wide or line-specific status.
- `subway_alerts`: Get detailed service alerts and disruptions.
- `service_disruptions`: Analyze disruptions and alternative options.

#### Accessibility Tools
- `elevator_and_escalator_status`: Check current and upcoming equipment outages.

### Prompts
- `check_train_arrivals`: Ask for next trains at a specified station.
- `check_service_alerts`: Check for general or line-specific service alerts.
- `check_elevator_status`: Check if elevators are working at a specific station.

### Resources
- `subway_lines`: Reference data for all subway lines including colors and IDs.
- `major_stations`: List of major transfer hubs and connection points.

## Example Usage

### JavaScript / TypeScript
```javascript
// Check next trains
await client.callTool("next_trains", { station: "Union Square", line: "N" });

// Find accessible stations
await client.callTool("find_station", { query: "herald", include_accessibility: true });

// Check elevator status
await client.callTool("elevator_and_escalator_status", { station: "DeKalb Ave", equipment_type: "elevator" });
```

### Natural Language Queries
- "Where is the Q train at DeKalb Av?"
- "Are there any service alerts for my commute?"
- "Stations near Times Square"
- "Are the elevators working at Union Square?"

## Data Sources

- **Real-time feeds**: All NYC subway lines via MTA GTFS-RT.
- **Static data**: Stations, routes, transfers (auto-downloaded).
- **Service alerts**: Live disruption and delay information.
- **Equipment data**: Official MTA JSON feed for elevators and escalators.
- **Update frequency**: Every 30 seconds for real-time data.

## Deployment

### Smithery
```bash
npx @smithery/cli deploy
```

### Traditional MCP
Use `npm start` for stdio protocol integration with any MCP client.

## MTA Compliance & Usage Terms

This server is designed for individual, non-commercial use.

- **Personal use only**: Direct MTA feed access is permitted for personal development.
- **Attribution required**: "Data from MTA" must be included in outputs.
- **No redistribution**: Raw feed data cannot be redistributed.
- **Public distribution**: Requires a dedicated data caching server and MTA license.

**Data Disclaimers:**
- Data is provided "as is" without accuracy guarantees.
- Service may be subject to processing delays.
- This project is not affiliated with or endorsed by the MTA.

## License

MIT License - see LICENSE file for details.
