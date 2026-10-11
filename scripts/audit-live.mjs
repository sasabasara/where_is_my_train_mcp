// Read-only audit: snapshots each upstream response once, checks every station against
// independently decoded protobufs, then makes a small set of normal production calls.
// Run after npm run build: node scripts/audit-live.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import protobuf from 'protobufjs';
import { performance } from 'node:perf_hooks';

const nativeFetch = globalThis.fetch;
const snapshots = new Map();
const network = [];
globalThis.fetch = async (url, options) => {
  const key = String(url);
  if (!snapshots.has(key)) {
    snapshots.set(key, (async () => {
      const start = performance.now();
      const response = await nativeFetch(url, { ...options, signal: options?.signal ?? AbortSignal.timeout(20_000) });
      const bytes = new Uint8Array(await response.arrayBuffer());
      network.push({ url: key, status: response.status, ms: Math.round(performance.now() - start) });
      return { bytes, status: response.status, headers: response.headers };
    })());
  }
  const saved = await snapshots.get(key);
  return new Response(saved.bytes, { status: saved.status, headers: saved.headers });
};

const stations = await import('../dist/src/services/stationService.js');
const info = await import('../dist/src/services/stationInfoService.js');
const mta = await import('../dist/src/services/mtaService.js');
const handlers = await import('../dist/src/handlers/toolHandlers.js');
const alerts = await import('../dist/src/services/alertService.js');
const payload = result => JSON.parse(result.content[0].text);
const checks = { stations: 0, arrivals: 0, directionChecks: 0, nameChecks: 0, transferChecks: 0, nearestChecks: 0, rawComparisons: 0, outageSearches: 0, alertStationPairs: 0 };
const failures = [];
const check = (name, fn) => { try { fn(); } catch (e) { failures.push({ check: name, error: e.message }); } };
const start = performance.now();
await stations.ensureDataLoaded();
const [rows, combined, outages, parsedAlerts] = await Promise.all([
  fetch('https://data.ny.gov/resource/39hk-dx4f.json?$limit=5000').then(r => { if (!r.ok) throw new Error(`Stations: ${r.status}`); return r.json(); }),
  mta.fetchMTAData(), mta.fetchEquipmentOutages(), alerts.getSubwayAlerts({ activeOnly: true })
]);
await info.ensureStationInfoLoaded();
info.setStations(rows);
await mta.fetchEquipmentList();
const loadMs = Math.round(performance.now() - start);
const realNow = Date.now;
const snapshotTime = Date.now();
Date.now = () => snapshotTime;

const root = await protobuf.load(['src/schemas/gtfs-realtime.proto', 'src/schemas/nyct-subway.proto']);
const Feed = root.lookupType('transit_realtime.FeedMessage');
const rawEntities = [];
const feedSummary = [];
for (const [url, pending] of snapshots) {
  if (!url.includes('/nyct%2Fgtfs')) continue;
  const { bytes, status } = await pending;
  if (status !== 200) continue;
  const raw = Feed.toObject(Feed.decode(bytes), { longs: String, enums: String, arrays: true });
  rawEntities.push(...raw.entity);
  feedSummary.push({ feed: decodeURIComponent(url).split('/').at(-1), ageSeconds: Math.round(snapshotTime / 1000 - Number(raw.header.timestamp)), trips: raw.entity.filter(e => e.tripUpdate).length });
}
const stops = stations.getStopsData();
const known = new Map(stops.map(s => [s.stop_id, s]));
const parents = stops.filter(s => s.location_type === '1');
const rowById = new Map(rows.map(r => [r.gtfs_stop_id, r]));
const rawArrivals = [];
let canceled = 0, skipped = 0;
for (const entity of rawEntities) {
  const update = entity.tripUpdate;
  if (entity.isDeleted || !update?.trip) continue;
  if (['CANCELED', 'DELETED'].includes(update.trip.scheduleRelationship)) { canceled++; continue; }
  const serving = (update.stopTimeUpdate ?? []).filter(s => s.scheduleRelationship !== 'SKIPPED');
  const terminal = serving.findLast(s => known.has(s.stopId)) ?? serving.at(-1);
  for (const stop of update.stopTimeUpdate ?? []) {
    if (stop.scheduleRelationship === 'SKIPPED') skipped++;
    if (stop === terminal || ['SKIPPED', 'NO_DATA'].includes(stop.scheduleRelationship)) continue;
    const time = Number(stop.arrival?.time ?? stop.departure?.time) * 1000;
    if (!Number.isFinite(time) || time < snapshotTime - 30_000) continue;
    rawArrivals.push({ stopId: stop.stopId, tripId: update.trip.tripId, line: update.trip.routeId, time });
  }
}
const key = a => `${a.stopId}|${a.tripId}|${a.line}|${a.time ?? a.arrivalTimestamp}`;
const durations = [];
for (const station of parents) {
  checks.stations++;
  const row = rowById.get(station.stop_id);
  const members = row ? rows.filter(r => r.complex_id === row.complex_id).map(r => r.gtfs_stop_id) : [station.stop_id];
  const memberSet = new Set(members);
  const timeStart = performance.now();
  const result = payload(await handlers.handleNextTrains({ stop_id: station.stop_id, limit: 10 }));
  durations.push(performance.now() - timeStart);
  check(`${station.stop_id}: arrivals`, () => {
    assert.equal(result.status, 'success');
    const arrivals = result.data.arrivals;
    checks.arrivals += arrivals.length;
    for (const [i, a] of arrivals.entries()) {
      assert(memberSet.has(a.stopId.replace(/[NS]$/, '')));
      assert(a.arrivalTimestamp >= snapshotTime - 30_000);
      if (i) assert(arrivals[i - 1].arrivalTimestamp <= a.arrivalTimestamp);
      assert.notEqual(a.direction, 'Last Stop');
      assert(!/^[A-Z]?\d{2,3}[NS]$/.test(a.destination));
    }
    const expected = rawArrivals.filter(a => memberSet.has(a.stopId?.replace(/[NS]$/, ''))).sort((a, b) => a.time - b.time);
    assert.equal(arrivals.length, Math.min(10, expected.length));
    const allowed = new Set(expected.map(key));
    for (const a of arrivals) assert(allowed.has(key(a)), `unexpected ${key(a)}`);
    if (arrivals.length) {
      const cutoff = expected[Math.min(9, expected.length - 1)].time;
      assert.equal(arrivals.at(-1).arrivalTimestamp, cutoff);
      const actual = new Set(arrivals.map(key));
      for (const a of expected.filter(a => a.time < cutoff)) assert(actual.has(key(a)), `missing ${key(a)}`);
    }
    checks.rawComparisons++;
  });
  for (const direction of ['N', 'S']) {
    const d = payload(await handlers.handleNextTrains({ stop_id: station.stop_id, direction, limit: 10 }));
    check(`${station.stop_id}: ${direction}`, () => {
      assert.equal(d.status, 'success');
      for (const a of d.data.arrivals) { assert(a.stopId.endsWith(direction)); checks.directionChecks++; }
    });
  }
  const found = payload(await handlers.handleFindStation({ query: station.stop_name }));
  check(`${station.stop_id}: find by name`, () => { assert(found.data.stations.some(s => s.stopIds.includes(station.stop_id))); checks.nameChecks++; });
  const transfers = payload(await handlers.handleStationTransfers({ stop_id: station.stop_id }));
  check(`${station.stop_id}: transfers`, () => { assert.equal(transfers.status, 'success'); assert(transfers.data.connections.some(s => s.stopId === station.stop_id)); checks.transferChecks++; });
  const nearby = payload(await handlers.handleNearestStation({ lat: Number(station.stop_lat), lon: Number(station.stop_lon), radius: 100, limit: 20 }));
  check(`${station.stop_id}: nearest`, () => { assert(nearby.data.some(s => s.stopIds.includes(station.stop_id))); checks.nearestChecks++; });
}
for (const outage of outages) {
  const result = payload(await handlers.handleElevatorEscalatorStatus({ station: outage.station, outage_type: 'all' }));
  check(`outage ${outage.equipment}`, () => { assert(result.data.outages.some(o => o.equipmentId === outage.equipment)); checks.outageSearches++; });
}
for (const alert of parsedAlerts) {
  for (const id of alert.affectedStopIds) {
    const name = stations.getStopName(id);
    const result = payload(await handlers.handleServiceDisruptions({ location: name }));
    check(`alert ${alert.id} at ${id}`, () => { assert(result.data.disruptions.some(d => d.title === alert.header)); checks.alertStationPairs++; });
  }
}
Date.now = realNow;
globalThis.fetch = nativeFetch;

const prod = 'https://whereismytrainmcp-production.up.railway.app';
const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const prodCalls = [];
let session;
let requestId = 1;
async function rpc(method, params) {
  const started = performance.now();
  const response = await nativeFetch(`${prod}/mcp`, { method: 'POST', headers: { ...headers, ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId++, method, params }), signal: AbortSignal.timeout(30_000) });
  session ??= response.headers.get('mcp-session-id');
  const data = await response.json();
  prodCalls.push({ method, tool: params?.name, status: response.status, isError: Boolean(data.error || data.result?.isError), ms: Math.round(performance.now() - started) });
  assert.equal(response.status, 200);
  assert(!data.error);
  return data.result;
}
try {
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'codex-readonly-audit', version: '1' } });
  const tools = await rpc('tools/list');
  assert.equal(tools.tools.length, 8);
  for (const [name, args] of [
    ['next_trains', { stop_id: '635N', line: '6' }],
    ['next_trains', { station: '23 st' }],
    ['find_station', { query: 'St. George' }],
    ['find_station', { query: 'Fifth Avenue' }],
    ['service_status', { line: '6' }],
    ['subway_alerts', { line: 'L' }],
    ['service_disruptions', { line: '3' }],
    ['station_transfers', { station: 'times sq' }],
    ['elevator_and_escalator_status', { station: '25th st' }]
  ]) {
    const result = await rpc('tools/call', { name, arguments: args });
    check(`production ${name}`, () => assert(!result.isError));
  }
  await rpc('resources/read', { uri: 'subway://lines' });
  await rpc('resources/read', { uri: 'subway://major-stations' });
} finally {
  if (session) await nativeFetch(`${prod}/mcp`, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': session }, signal: AbortSignal.timeout(10_000) });
}
durations.sort((a, b) => a - b);
const report = {
  capturedAt: new Date(snapshotTime).toISOString(), checks, failures,
  feedStatus: combined.feedStatus, feeds: feedSummary, canceledTrips: canceled, skippedStops: skipped,
  timings: { initialDataLoadMs: loadMs, cachedArrivalsP50Ms: Number(durations[Math.floor(durations.length * .5)].toFixed(2)), cachedArrivalsP99Ms: Number(durations[Math.floor(durations.length * .99)].toFixed(2)) },
  network, production: prodCalls
};
await fs.mkdir('.dev_docs', { recursive: true });
await fs.writeFile('.dev_docs/audit-results.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
