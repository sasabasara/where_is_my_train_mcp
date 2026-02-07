# Where's My Train? — MCP Server (NYC Subway)

[![smithery badge](https://smithery.ai/badge/@sasabasara/where_is_my_train_mcp)](https://smithery.ai/server/@sasabasara/where_is_my_train_mcp)

A Model Context Protocol (MCP) server for real-time NYC subway info: arrivals, station lookup, service alerts, accessibility status, and more — powered by live MTA feeds.

> Data from the MTA • Personal use only • Not endorsed by the MTA • Provided “as is”

## What this gives you

- **Real-time arrivals**: upcoming trains for a station/line (with extra signals like crowding when available).
- **Station search**: fuzzy name matching + optional accessibility info.
- **Service alerts & disruptions**: system-wide or line-specific status and advisories.
- **Elevator & escalator status**: live outage info for accessibility planning.
- **Nearby station lookups (location-aware)**: find stations near a **lat/lon** (great for “near me” if your client provides GPS; also works for “near Times Square” when the model/client can resolve it to coordinates).
- **Transfers**: basic transfer options at a station.
- **Live MTA GTFS-RT**: coverage across subway lines.

## Usage

### Option 1: Remote (recommended)

Connect your MCP client to the hosted server — no local setup required:

```
https://whereismytrainmcp-production.up.railway.app/mcp
```

Also available on [Smithery](https://smithery.ai/server/@sasabasara/where_is_my_train_mcp).

### Option 2: Run locally

**Prereqs**
- Node.js 18+

```bash
git clone https://github.com/sasabasara/where_is_my_train_mcp.git
cd where_is_my_train_mcp
npm install
npm run build
npm start
```
