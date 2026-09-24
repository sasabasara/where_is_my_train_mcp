# Where's My Train? — MCP Server (NYC Subway)

[![Smithery](https://img.shields.io/badge/Smithery-Where's%20my%20train%3F-7c3aed)](https://smithery.ai/servers/sasabasara/where_is_my_train_mcp)

Live NYC subway info for Claude and other AI assistants: arrivals, delays, elevators, and stations — straight from MTA feeds.

> Data from the MTA • Personal use only • Not endorsed by the MTA • Provided “as is”

## Connect

No API key needed.

- **Smithery:** [smithery.ai/servers/sasabasara/where_is_my_train_mcp](https://smithery.ai/servers/sasabasara/where_is_my_train_mcp)
- **Self-hosted:** run it yourself (below), then point your client at `http://localhost:3000/mcp`:
  - **Claude Code:** `claude mcp add --transport http where-is-my-train http://localhost:3000/mcp`
  - **Other MCP clients:** add the URL as a Streamable HTTP server.

## Ask it things like

- "When's the next uptown 6 at Union Square?"
- "Next Manhattan-bound L from Bedford?"
- "Is the 2 train running OK right now?"
- "Is the elevator working at 34th St?"
- "Nearest accessible station to the Empire State Building?"
- "Any weekend service changes on the L?"

If a name fits several stations ("23rd St"), it asks which one.

## Tools

| Tool | What it does |
|---|---|
| `next_trains` | Live arrivals by station or stop ID, filtered by line and direction |
| `service_disruptions` | Is service disrupted right now — by line, area, or system-wide |
| `subway_alerts` | Official MTA alerts, current or upcoming |
| `service_status` | Quick snapshot: trains running and top alerts |
| `nearest_station` | Stations near a location, with lines and accessibility |
| `find_station` | Station search by name |
| `station_transfers` | Every line reachable at a station |
| `elevator_and_escalator_status` | Current and upcoming outages, with MTA detours |

## Data

- **Arrivals:** MTA GTFS-realtime feeds (protobuf), refreshed about every 30 seconds. `confirmed: true` means a real train is on its way, not just a scheduled trip.
- **Alerts:** MTA service alerts, with the MTA's own type and severity.
- **Elevators:** MTA elevator and escalator outage feeds.
- **Stations:** MTA static GTFS plus the [MTA Subway Stations](https://data.ny.gov/resource/39hk-dx4f) list for complexes, directions, and accessibility.

## Run locally

Requires Node.js 22+.

```bash
git clone https://github.com/sasabasara/where_is_my_train_mcp.git
cd where_is_my_train_mcp
npm install
npm run build
npm start        # http://localhost:3000/mcp
npm test         # unit tests
```

## License

MIT
