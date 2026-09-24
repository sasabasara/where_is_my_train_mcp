import { fetchMTAData, fetchEquipmentOutages, fetchEquipmentList } from "../services/mtaService.js";
import { getSubwayAlerts } from "../services/alertService.js";
import {
  ensureStationInfoLoaded,
  getStationInfo,
  getComplexStations,
  getComplexRoutes,
  routeMatchesLine,
  stationServesLine,
  directionLabel,
  directionMatches,
  sortRoutes
} from "../services/stationInfoService.js";
import { StationMatcher, getStopsData, getTransfersData, getStopName, ensureDataLoaded } from "../services/stationService.js";
import { calculateDistance } from "../utils/index.js";
import { ServiceDisruptionAnalyzer } from "../services/serviceDisruptions.js";
import {
  StandardResponse,
  ToolResponse,
  FindStationArgs,
  NextTrainsArgs,
  ServiceStatusArgs,
  SubwayAlertsArgs,
  StationTransfersArgs,
  NearestStationArgs,
  ServiceDisruptionsArgs,
  ElevatorEscalatorStatusArgs,
  EquipmentOutage,
  StationInfo
} from "../types/index.js";

/**
 * Standardizes tool responses into a consistent JSON structure.
 */
function createStandardResponse(data: any, message: string, isError = false): ToolResponse {
  const response: StandardResponse = {
    status: isError ? "error" : "success",
    data,
    message,
    metadata: {
      timestamp: Date.now()
    }
  };

  return {
    content: [{
      type: "text",
      text: JSON.stringify(response, null, 2)
    }],
    ...(isError && { isError: true })
  };
}

// New tool handlers
export async function handleServiceDisruptions(args: ServiceDisruptionsArgs): Promise<ToolResponse> {
  try {
    const alerts = await getSubwayAlerts({ line: args.line, severity: args.severity, activeOnly: true });
    const analysis = ServiceDisruptionAnalyzer.analyze(args, alerts);
    return createStandardResponse(analysis, `Service disruption analysis for ${args.line || 'system'}`);
  } catch (error) {
    return createStandardResponse(null, "Service disruption analysis temporarily unavailable.", true);
  }
}

const BOROUGHS: Record<string, string> = { M: 'Manhattan', Bk: 'Brooklyn', Bx: 'Bronx', Q: 'Queens', SI: 'Staten Island' };

function complexAccessibility(stations: StationInfo[]): StationInfo['accessibility'] | null {
  if (stations.length === 0) return null;
  if (stations.every(s => s.accessibility === 'full')) return 'full';
  if (stations.some(s => s.accessibility !== 'none')) return 'partial';
  return 'none';
}

/** Station summary used by find_station / nearest_station / ambiguity responses. */
function describeComplex(stopId: string, fallbackName: string) {
  const complex = getComplexStations(stopId);
  const info = getStationInfo(stopId);
  return {
    name: info?.name ?? fallbackName,
    stopIds: complex.length > 0 ? complex.map(s => s.stopId) : [stopId],
    lines: getComplexRoutes(stopId),
    borough: info ? BOROUGHS[info.borough] ?? info.borough : null,
    accessibility: complexAccessibility(complex),
    accessibilityNotes: accessibilityNotes(complex)
  };
}

/** e.g. "Accessible: L, N Q R W. Not accessible: 4 5 6" for a partly accessible complex. */
function accessibilityNotes(complex: StationInfo[]): string | null {
  const notes = complex.map(s => s.accessibilityNotes ? `${s.routes.join(' ')}: ${s.accessibilityNotes}` : null).filter(Boolean);
  const accessible = complex.filter(s => s.accessibility === 'full').map(s => s.routes.join(' '));
  const inaccessible = complex.filter(s => s.accessibility === 'none').map(s => s.routes.join(' '));
  if (accessible.length > 0 && inaccessible.length > 0) {
    notes.unshift(`Accessible: ${accessible.join(', ')}. Not accessible: ${inaccessible.join(', ')}`);
  }
  return notes.join('; ') || null;
}

const complexOf = (stopId: string) => getStationInfo(stopId)?.complexId;

export async function handleFindStation(args: FindStationArgs): Promise<ToolResponse> {
  await Promise.all([ensureDataLoaded(), ensureStationInfoLoaded()]);

  const stationQuery = args?.query?.trim() || "";
  if (!stationQuery) {
    return createStandardResponse(null, "Please provide a valid station name.", true);
  }

  try {
    const stopsData = getStopsData();
    const matches = StationMatcher.findBestMatches(stationQuery, stopsData);
    const groups = StationMatcher.groupByComplex(matches, complexOf);

    if (groups.length === 0) {
      return createStandardResponse({ query: stationQuery }, `No stations found matching "${stationQuery}". Try a different spelling or use partial names.`, true);
    }

    const stations = groups.map(group => ({
      ...describeComplex(group.stopIds[0], group.name),
      name: group.name,
      score: group.score,
      matchType: group.matchType
    }));

    const result = {
      searchQuery: stationQuery,
      stationsFound: stations.length,
      stations,
      timestamp: Date.now()
    };

    return createStandardResponse(
      result,
      `Found ${stations.length} stations matching "${stationQuery}"`
    );
  } catch (error) {
    return createStandardResponse(null, "Station search temporarily unavailable.", true);
  }
}

type ResolvedStation =
  | { kind: 'station'; name: string; parentIds: string[] }
  | { kind: 'ambiguous'; options: ReturnType<typeof describeComplex>[] }
  | { kind: 'not_found'; message: string };

/**
 * Resolve a rider's station name (or a stop_id) to one station complex.
 * Returns the choices instead when the name fits several separate stations.
 */
function resolveStation(query: string, stopId: string, line?: string): ResolvedStation {
  const stopsData = getStopsData();

  if (stopId) {
    const parent = stopsData.find(stop => stop.stop_id === stopId && stop.location_type === '1');
    if (!parent) return { kind: 'not_found', message: `No station with stop_id "${stopId}"` };
    const complex = getComplexStations(stopId);
    return { kind: 'station', name: parent.stop_name, parentIds: complex.length > 0 ? complex.map(s => s.stopId) : [stopId] };
  }

  const matches = StationMatcher.findBestMatches(query, stopsData);
  if (matches.length === 0) return { kind: 'not_found', message: `No stations found matching "${query}"` };

  // Best-scoring matches, plus any major hub the name matched: "14th st" should also offer
  // 14 St-Union Sq, "atlantic ave" Atlantic Av-Barclays Ctr, "42nd st" Grand Central-42 St
  const topScore = matches[0].score;
  const shortlist = matches.filter(m => m.score === topScore || m.isHub);
  let candidates = StationMatcher.groupByComplex(shortlist, complexOf);

  if (line) {
    const servesLine = candidates.filter(c =>
      getComplexStations(c.stopIds[0]).some(s => stationServesLine(s, line))
    );
    if (servesLine.length > 0) candidates = servesLine;
  }

  if (candidates.length > 1) {
    return { kind: 'ambiguous', options: candidates.map(c => describeComplex(c.stopIds[0], c.name)) };
  }

  const chosen = candidates[0];
  const complex = getComplexStations(chosen.stopIds[0]);
  return { kind: 'station', name: chosen.name, parentIds: complex.length > 0 ? complex.map(s => s.stopId) : chosen.stopIds };
}

function ambiguousResponse(query: string, options: ReturnType<typeof describeComplex>[], extra: Record<string, unknown> = {}) {
  return createStandardResponse(
    { query, ambiguous: true, options, ...extra },
    `"${query}" matches ${options.length} different stations. Ask the rider which one, then call again with its stop_id (or pass line).`
  );
}

export async function handleNextTrains(args: NextTrainsArgs): Promise<ToolResponse> {
  await Promise.all([ensureDataLoaded(), ensureStationInfoLoaded()]);

  const stationQuery = args?.station?.trim() || "";
  const stopIdArg = args?.stop_id?.trim().toUpperCase().replace(/[NS]$/, '') || "";
  if (!stationQuery && !stopIdArg) {
    return createStandardResponse(null, "Please provide a station name or stop_id.", true);
  }

  try {
    const resolved = resolveStation(stationQuery, stopIdArg, args.line);
    if (resolved.kind === 'not_found') {
      return createStandardResponse({ query: stopIdArg || stationQuery }, resolved.message, true);
    }
    if (resolved.kind === 'ambiguous') {
      return ambiguousResponse(stationQuery, resolved.options, { arrivals: [], count: 0 });
    }
    const { name: stationName, parentIds } = resolved;

    const parentIdSet = new Set(parentIds);
    const data = await fetchMTAData();
    const arrivals: any[] = [];
    const now = Date.now();
    const PAST_GRACE_MS = 30 * 1000;

    for (const entity of data.entity || []) {
      if (!entity.tripUpdate) continue;
      const trip = entity.tripUpdate.trip;
      if (args.line && !routeMatchesLine(trip.routeId, args.line)) continue;

      const updates: any[] = entity.tripUpdate.stopTimeUpdate || [];
      const terminal = updates[updates.length - 1];
      const terminalInfo = terminal?.stopId ? getStationInfo(terminal.stopId) : undefined;

      for (const update of updates) {
        if (!update.stopId) continue;
        const base = update.stopId.replace(/[NS]$/, '');
        if (!parentIdSet.has(base)) continue;
        // The train ends its run here — nothing to board
        if (update === terminal) continue;

        const t = update.arrival?.time ?? update.departure?.time;
        const arrivalTimestamp = t ? Number(t) * 1000 : null;
        if (arrivalTimestamp === null) continue;
        if (arrivalTimestamp < now - PAST_GRACE_MS) continue;

        arrivals.push({
          line: trip.routeId,
          direction: directionLabel(update.stopId),
          destination: terminal?.stopId ? getStopName(terminal.stopId) : 'Unknown destination',
          destinationBorough: terminalInfo ? BOROUGHS[terminalInfo.borough] ?? null : null,
          arrivalTimestamp,
          station: getStationInfo(base)?.name ?? stationName,
          stopId: update.stopId,
          tripId: trip.tripId
        });
      }
    }
    arrivals.sort((a, b) => a.arrivalTimestamp - b.arrivalTimestamp);

    // Direction: the MTA platform label ("Uptown", "Manhattan"), the train's destination
    // ("coney island") or its borough ("bronx"). If nothing matches, show every direction.
    const labelsSeen = arrivals.map(a => a.direction).filter(Boolean);
    const availableDirections = [...new Set(labelsSeen.length > 0
      ? labelsSeen
      : parentIds.flatMap(id => [directionLabel(`${id}N`), directionLabel(`${id}S`)]).filter(Boolean))] as string[];

    const notes: string[] = [];
    let shown = arrivals;
    const direction = args.direction?.trim();
    if (direction) {
      const q = direction.toLowerCase();
      const matching = arrivals.filter(a =>
        directionMatches(a.stopId, direction) ||
        a.destination.toLowerCase().includes(q) ||
        (a.destinationBorough ?? '').toLowerCase().includes(q)
      );
      if (matching.length > 0) {
        shown = matching;
      } else if (arrivals.length > 0) {
        notes.push(`No upcoming trains match "${direction}" (directions here: ${availableDirections.join(', ')}); showing all directions.`);
      }
    }

    if (args.line && arrivals.length === 0) {
      const complex = getComplexStations(parentIds[0]);
      if (complex.length > 0 && !complex.some(s => stationServesLine(s, args.line!))) {
        notes.push(`The ${args.line.toUpperCase()} isn't a daytime line at ${stationName} (daytime lines: ${getComplexRoutes(parentIds[0]).join(' ')}); night and weekend service can differ.`);
      }
    }
    if (arrivals.length === 0) {
      notes.push(`No upcoming ${args.line ? `${args.line.toUpperCase()} ` : ''}trains in the real-time feed for this station right now — the line may not run at this hour or may be suspended (see service_disruptions).`);
    }

    const limit = Math.min(Math.max(Math.trunc(args.limit ?? 5) || 5, 1), 10);
    const result: Record<string, unknown> = {
      station: stationName,
      stopIds: parentIds,
      lines: getComplexRoutes(parentIds[0]),
      availableDirections,
      arrivals: shown.slice(0, limit),
      count: Math.min(shown.length, limit)
    };
    if (notes.length > 0) {
      result.note = notes.join(' ');
    }
    if (data.feedStatus?.failedFeeds?.length) {
      result.unavailableFeeds = data.feedStatus.failedFeeds;
    }

    return createStandardResponse(result, `Found ${result.count} upcoming trains for ${stationName}`);
  } catch (error) {
    return createStandardResponse(null, "Train arrival data temporarily unavailable.", true);
  }
}

export async function handleServiceStatus(args: ServiceStatusArgs): Promise<ToolResponse> {
  try {
    const line = args.line?.trim().toUpperCase();
    const [data, alerts] = await Promise.all([
      fetchMTAData(),
      getSubwayAlerts({ line, activeOnly: true })
    ]);

    const trips = (data.entity || []).filter((e: any) => e.tripUpdate && (!line || routeMatchesLine(e.tripUpdate.trip?.routeId, line)));

    const result = {
      line: line || null,
      activeTrips: trips.length,
      activeAlerts: alerts.length,
      topAlerts: alerts.slice(0, 3).map(a => ({ header: a.header, severity: a.severity, alertType: a.alertType, affectedLines: a.affectedLines })),
      unavailableFeeds: data.feedStatus?.failedFeeds ?? []
    };

    return createStandardResponse(result, `Service status for ${line ? `the ${line} line` : 'the system'}`);
  } catch (error) {
    return createStandardResponse(null, "Service status temporarily unavailable.", true);
  }
}

export async function handleSubwayAlerts(args: SubwayAlertsArgs): Promise<ToolResponse> {
  try {
    const alerts = await getSubwayAlerts({
      line: args.line,
      activeOnly: args.active_only ?? true,
      severity: args.severity,
      category: args.category
    });

    const MAX_ALERTS = 15;
    const result = {
      total: alerts.length,
      returned: Math.min(alerts.length, MAX_ALERTS),
      alerts: alerts.slice(0, MAX_ALERTS).map(a => ({
        header: a.header,
        description: a.description,
        alertType: a.alertType,
        severity: a.severity,
        category: a.category,
        affectedLines: a.affectedLines,
        isActive: a.isActive,
        activePeriod: a.activePeriod,
        updatedAt: a.updatedAt
      }))
    };

    return createStandardResponse(result, `Found ${result.total} alerts for ${args.line || 'system'}${result.total > result.returned ? ` (showing ${result.returned} most severe)` : ''}`);
  } catch (error) {
    return createStandardResponse(null, "Subway alerts temporarily unavailable.", true);
  }
}

export async function handleStationTransfers(args: StationTransfersArgs): Promise<ToolResponse> {
  await Promise.all([ensureDataLoaded(), ensureStationInfoLoaded()]);
  const stationQuery = args?.station?.trim() || "";
  if (!stationQuery) {
    return createStandardResponse(null, "Please provide a station name.", true);
  }

  try {
    const resolved = resolveStation(stationQuery, '');
    if (resolved.kind === 'not_found') {
      return createStandardResponse({ query: stationQuery }, resolved.message, true);
    }
    if (resolved.kind === 'ambiguous') {
      return ambiguousResponse(stationQuery, resolved.options);
    }

    // Everything in the complex, plus any transfers.txt partners outside it
    const connectedIds = new Set(resolved.parentIds);
    for (const t of getTransfersData()) {
      if (connectedIds.has(t.from_stop_id)) connectedIds.add(t.to_stop_id);
      if (connectedIds.has(t.to_stop_id)) connectedIds.add(t.from_stop_id);
    }

    const connections = [...connectedIds].map(id => ({
      name: getStationInfo(id)?.name ?? getStopName(id),
      stopId: id,
      lines: getStationInfo(id)?.routes ?? []
    }));

    const result = {
      station: resolved.name,
      lines: sortRoutes([...new Set(connections.flatMap(c => c.lines))]),
      connections
    };

    return createStandardResponse(result, `${resolved.name}: ${result.lines.length} lines across ${connections.length} connected platforms`);
  } catch (error) {
    return createStandardResponse(null, "Transfer information temporarily unavailable.", true);
  }
}

export async function handleNearestStation(args: NearestStationArgs): Promise<ToolResponse> {
  await Promise.all([ensureDataLoaded(), ensureStationInfoLoaded()]);
  if (args?.lat === undefined || args?.lon === undefined) {
    return createStandardResponse(null, "GPS coordinates (lat/lon) are required.", true);
  }

  try {
    const stopsData = getStopsData();
    const radius = args.radius || 1000;
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? 5) || 5, 1), 20);

    // Nearest platform per complex, so Union Sq shows up once, not three times
    const byComplex = new Map<string, { stopId: string; stopName: string; distance: number; lat: number; lon: number }>();
    for (const stop of stopsData) {
      if (stop.location_type !== '1' || !stop.stop_lat || !stop.stop_lon) continue;
      const lat = Number(stop.stop_lat), lon = Number(stop.stop_lon);
      const distance = Math.round(calculateDistance(args.lat, args.lon, lat, lon));
      if (distance > radius) continue;

      const key = complexOf(stop.stop_id) ?? stop.stop_id;
      const existing = byComplex.get(key);
      if (!existing || distance < existing.distance) {
        byComplex.set(key, { stopId: stop.stop_id, stopName: stop.stop_name, distance, lat, lon });
      }
    }

    let nearby = [...byComplex.values()]
      .sort((a, b) => a.distance - b.distance)
      .map(s => ({
        ...describeComplex(s.stopId, s.stopName),
        stopId: s.stopId,
        distance: s.distance,
        coordinates: { lat: s.lat, lon: s.lon }
      }));

    if (args.accessible_only) {
      nearby = nearby.filter(s => s.accessibility === 'full' || s.accessibility === 'partial');
    }
    if (args.service_filter?.length) {
      nearby = nearby.filter(s =>
        args.service_filter!.some(line => getComplexStations(s.stopId).some(st => stationServesLine(st, line)))
      );
    }

    nearby = nearby.slice(0, limit);
    const hint = nearby.length === 0 ? '. Try a larger radius (e.g. 3000m) — this spot may not be near the subway' : '';
    return createStandardResponse(nearby, `Found ${nearby.length} stations within ${radius}m${hint}`);
  } catch (error) {
    return createStandardResponse(null, "Nearest station search temporarily unavailable.", true);
  }
}

export async function handleElevatorEscalatorStatus(args: ElevatorEscalatorStatusArgs): Promise<ToolResponse> {
  try {
    const [allOutages, equipmentList] = await Promise.all([fetchEquipmentOutages(), fetchEquipmentList()]);
    const equipmentById = new Map<string, any>(equipmentList.map((e: any) => [e.equipmentno, e]));
    let filtered: EquipmentOutage[] = allOutages;

    const outageType = args.outage_type ?? 'current';
    if (outageType === 'current') filtered = filtered.filter(item => item.isupcomingoutage !== 'Y');
    if (outageType === 'upcoming') filtered = filtered.filter(item => item.isupcomingoutage === 'Y');

    if (args.equipment_type === 'elevator') filtered = filtered.filter(item => item.equipmenttype === 'EL');
    if (args.equipment_type === 'escalator') filtered = filtered.filter(item => item.equipmenttype === 'ES');

    if (args.station) {
      // Normalize both sides so "union square" / "34th st" match "14 St-Union Sq" / "34 St-Herald Sq"
      const q = StationMatcher.normalizeStationName(args.station);
      filtered = filtered.filter(item => StationMatcher.normalizeStationName(item.station).includes(q));
    }

    if (args.ada_only) {
      filtered = filtered.filter(item => item.ADA === 'Y');
    }

    const MAX_OUTAGES = 25;
    const outages = filtered.slice(0, MAX_OUTAGES).map(item => ({
      station: item.station,
      lines: item.trainno,
      equipment: item.equipmenttype === 'EL' ? 'Elevator' : 'Escalator',
      equipmentId: item.equipment,
      serving: item.serving,
      ada: item.ADA === 'Y',
      status: item.isupcomingoutage === 'Y' ? 'Upcoming Work' : 'Currently Out',
      reason: item.reason,
      outageStart: item.outagedate,
      estimatedReturn: item.estimatedreturntoservice || null,
      alternativeRoute: equipmentById.get(item.equipment)?.alternativeroute || null
    }));

    const result = { total: filtered.length, returned: outages.length, outages };
    return createStandardResponse(result, `Found ${result.total} equipment outages${result.total > result.returned ? ` (showing ${result.returned})` : ''}`);
  } catch (error) {
    return createStandardResponse(null, "Elevator and escalator status temporarily unavailable.", true);
  }
}
