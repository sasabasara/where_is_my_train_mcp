# Where's my train? MCP Server 

[![smithery badge](https://smithery.ai/badge/@sasabasara/where_is_my_train_mcp)](https://smithery.ai/server/@sasabasara/where_is_my_train_mcp)

A MCP server for real-time NYC subway information. Leverages AI/LLM geographic knowledge for intelligent location handling and provides structured JSON data for stations, arrivals, alerts, and service status with live MTA data.

> **Data from MTA** • Personal use only • Not endorsed by MTA • Data provided "as is"

## Quick Examples

- "where's my train? I'm looking for the Q at DeKalb Av"

## Features

- **Real-time train arrivals** with crowding information
- **Station search** with fuzzy matching and accessibility info
- **Service alerts** and disruption analysis
- **Intelligent location handling** - AI converts location names to coordinates
- **Nearby station finder** using GPS coordinates or location names
- **Transfer information** for complex routes
- **Live MTA GTFS-RT data** from all subway lines

## Usage

### Option 1: Use on Smithery (Recommended)
**Instant access** - Visit [smithery.ai/server/@sasabasara/where_is_my_train_mcp](https://smithery.ai/server/@sasabasara/where_is_my_train_mcp) and click "Install" to add it to your AI client.

No setup required - works immediately with Claude, ChatGPT, Cursor, and other MCP-compatible clients.

### Option 2: Run Locally

**Prerequisites:**
- Node.js 18+

**Quick Start:**
```bash
# Clone and install
git clone <your-repo>
cd whereismytrain-mcp
npm install

# Start development server (recommended)
npm run dev

# Or start traditional MCP server
npm start
```

**That's it!** The server automatically downloads and caches MTA GTFS data on first run.

### What You Can Do

**Station-Based Queries:**
- Find stations: `"find Times Square station"`
- Next trains: `"next trains at Union Square"`
- Transfers: `"transfers at Atlantic Ave"`

**System Information:**
- Service status and alerts
- Real-time disruptions
- Train crowding data

**Location-Based Searches:**
- Nearest stations: `"stations near Times Square"` or `"near SoHo"`
- GPS coordinates: `lat: 40.7589, lon: -73.9851`
- AI automatically converts location names to coordinates

### What You Cannot Do (MTA Data Limitations)

**Complex Journey Planning:**
- ❌ Multi-modal transit (bus + subway combinations)
- ❌ Real-time traffic-aware routing
- ❌ Ride-sharing integration
- ✅ AI can chain tools for basic subway journey planning

**Non-Subway Transit:**
- ❌ Bus routes and schedules
- ❌ LIRR, Metro-North, NJ Transit
- ❌ Ferry, taxi, rideshare information
- ✅ NYC Subway only (all lines: 1-7, A-Z, shuttles)

**Historical/Future Data:**
- ❌ Past service performance
- ❌ Schedules beyond ~2 hours
- ❌ Planned service changes (beyond current alerts)
- ✅ Real-time data only (current conditions)

## Tools

### Core Tools
- **`next_trains`** - Real-time arrivals with crowding indicators
- **`find_station`** - Fuzzy station search with accessibility info
- **`nearest_station`** - Find closest stations (AI converts location names to coordinates)
- **`station_transfers`** - Transfer options at stations

### System Tools
- **`service_status`** - System-wide or line-specific status
- **`subway_alerts`** - Detailed service alerts with filtering
- **`service_disruptions`** - Disruption analysis with alternatives


### Example Queries

```javascript
// Core functionality
next_trains("Union Square", "N")  // N trains at Union Square
find_station("herald", true)      // Herald stations with accessibility
nearest_station({lat: 40.7589, lon: -73.9851})  // GPS coordinates
station_transfers("Atlantic Ave") // Transfer options
service_status("Q")              // Q line status

// AI Enhanced Queries
"stations near Times Square"      // AI converts location → coordinates
"how to get from SoHo to Brooklyn" // AI chains multiple tools
"any service alerts for my commute?" // AI contextual understanding
```

## MTA Compliance & Usage Terms

**Personal Use Only** - This server is designed for individual, non-commercial use.

**Key Requirements:**
- ✅ **Personal development** - Direct MTA feed access permitted
- ❌ **Public distribution** - Requires data caching server and MTA license
- 📋 **Attribution required** - "Data from MTA" in outputs
- 🚫 **No redistribution** of raw feed data

**Data Disclaimers:**
- Data provided "as is" without accuracy guarantees
- May be delayed or incomplete due to processing
- Not affiliated with or endorsed by MTA

For production/public use, you must implement proper data caching infrastructure and obtain MTA licensing.

## Deployment

### Smithery (Recommended)
```bash
npx @smithery/cli deploy
```

### Traditional MCP
Use `npm start` for stdio protocol with any MCP client.

## Data Sources

- **Real-time feeds**: All NYC subway lines via MTA GTFS-RT
- **Static data**: Stations, routes, transfers (auto-downloaded)
- **Service alerts**: Live disruption and delay information
- **Update frequency**: Every 30 seconds (real-time data)

## License

MIT License - see LICENSE file for details
