# Where's My Train? — MCP Server (NYC Subway)

[![Smithery](https://img.shields.io/badge/Smithery-Where's%20my%20train%3F-7c3aed)](https://smithery.ai/servers/sasabasara/where_is_my_train_mcp)

NYC subway info for Claude and other AI assistants: train arrivals, delays, elevators, and stations, from MTA data feeds.

> Data from MTA feeds, served from this project's own server. It **may not be real time**, and may be inaccurate or incomplete. Personal use only. Not affiliated with, endorsed, or licensed by the MTA. Provided “as is”.

## Connect

No install, no API key. The server is hosted at:

```
https://whereismytrainmcp-production.up.railway.app/mcp
```

- **Claude (web, desktop, mobile):** add it as a [custom connector](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) with the URL above.
- **Claude Code:**
  ```bash
  claude mcp add --transport http where-is-my-train https://whereismytrainmcp-production.up.railway.app/mcp
  ```
- **Other MCP clients:** use the URL as a Streamable HTTP server.
- **Smithery:** [smithery.ai/servers/sasabasara/where_is_my_train_mcp](https://smithery.ai/servers/sasabasara/where_is_my_train_mcp)

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
| `next_trains` | Predicted arrivals by station or stop ID, filtered by line and direction |
| `service_disruptions` | Is service disrupted right now — by line, area, or system-wide |
| `subway_alerts` | Official MTA alerts, current or upcoming |
| `service_status` | Quick snapshot: trains running and top alerts |
| `nearest_station` | Stations near a location, with lines and accessibility |
| `find_station` | Station search by name |
| `station_transfers` | Every line reachable at a station |
| `elevator_and_escalator_status` | Current and upcoming outages, with MTA detours |

## Data

- **Arrivals:** MTA GTFS-realtime feeds (protobuf), cached for 30 seconds, so predictions may lag the MTA. `confirmed: true` means the MTA has assigned a train to the trip. If a feed fails, predictions up to five minutes old may be returned with `staleFeeds` and a warning. Older feeds are rejected; canceled trips and skipped stops are excluded.
- **Alerts:** MTA service alerts, with the MTA's own type and severity. Cached for 30 seconds.
- **Elevators:** MTA elevator and escalator outage feeds, cached for 30 seconds. Equipment counts describe installed equipment, not a guarantee of an accessible route.
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

Tests include local HTTP/MCP integration checks and require permission to listen on localhost.
For an optional read-only audit against MTA data and the hosted server, run `node scripts/audit-live.mjs` after building. It checks every station, compares arrivals with independently decoded feeds, and writes its results to `.dev_docs/audit-results.json`.

The hosted server uses in-memory MCP sessions and currently requires a single instance. Request logs omit GPS coordinates from `nearest_station` calls.

## License

MIT
