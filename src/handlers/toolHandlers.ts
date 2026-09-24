import { fetchMTAData, fetchEquipmentOutages, fetchEquipmentList } from "../services/mtaService.js";
import { getSubwayAlerts } from "../services/alertService.js";
import { StationMatcher, getStopsData, getTransfersData, getGTFSSourceInfo, ensureDataLoaded } from "../services/stationService.js";
import { calculateDistance, getTrainDestination } from "../utils/index.js";
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
  GTFSEntity,
  MTAFeedData,
  Stop,
  Transfer
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
    const analysis = await ServiceDisruptionAnalyzer.analyze(args, alerts);
    return createStandardResponse(analysis, `Service disruption analysis for ${args.line || 'system'}`);
  } catch (error) {
    return createStandardResponse(null, "Service disruption analysis temporarily unavailable.", true);
  }
}

export async function handleFindStation(args: FindStationArgs): Promise<ToolResponse> {
  await ensureDataLoaded();

  const stationQuery = args?.query?.trim() || "";
  if (!stationQuery) {
    return createStandardResponse(null, "Please provide a valid station name.", true);
  }

  try {
    const stopsData = getStopsData();
    const matches = StationMatcher.findBestMatches(stationQuery, stopsData);
    const groups = StationMatcher.groupByName(matches);

    if (groups.length === 0) {
      return createStandardResponse({ query: stationQuery }, `No stations found matching "${stationQuery}". Try a different spelling or use partial names.`, true);
    }

    const result = {
      searchQuery: stationQuery,
      stationsFound: groups.length,
      stations: groups,
      timestamp: Date.now()
    };

    return createStandardResponse(
      result,
      `Found ${groups.length} stations matching "${stationQuery}"`
    );
  } catch (error) {
    return createStandardResponse(null, "Station search temporarily unavailable.", true);
  }
}

export async function handleNextTrains(args: NextTrainsArgs): Promise<ToolResponse> {
  await ensureDataLoaded();

  const stationQuery = args?.station?.trim() || "";
  if (!stationQuery) {
    return createStandardResponse(null, "Please provide a valid station name.", true);
  }

  try {
    const stopsData = getStopsData();
    const validStations = StationMatcher.findBestMatches(stationQuery, stopsData);

    if (validStations.length === 0) {
      return createStandardResponse({ query: stationQuery }, `No stations found matching "${stationQuery}"`, true);
    }

    // Use only the top-scoring tier for arrival matching
    const topScore = validStations[0].score;
    const topMatches = validStations.filter(s => s.score === topScore);
    const parentIds = new Set<string>(topMatches.map(s => s.parent_station || s.stop_id));
    const data = await fetchMTAData();
    const arrivals: any[] = [];
    const now = Date.now();
    const PAST_GRACE_MS = 30 * 1000;

    for (const entity of data.entity || []) {
      if (!entity.tripUpdate) continue;
      const trip = entity.tripUpdate.trip;
      if (args.line && trip.routeId !== args.line.toUpperCase()) continue;

      for (const update of entity.tripUpdate.stopTimeUpdate || []) {
        if (!update.stopId) continue;
        const base = update.stopId.replace(/[NS]$/, '');
        if (!parentIds.has(base)) continue;

        const t = update.arrival?.time ?? update.departure?.time;
        const arrivalTimestamp = t ? Number(t) * 1000 : null;
        if (arrivalTimestamp === null) continue;
        if (arrivalTimestamp < now - PAST_GRACE_MS) continue;

        const stopRecord = stopsData.find(stop => stop.stop_id === update.stopId);
        const stationName = stopRecord ? stopRecord.stop_name : update.stopId;

        arrivals.push({
          line: trip.routeId,
          destination: await getTrainDestination(entity.tripUpdate.stopTimeUpdate),
          arrivalTimestamp,
          station: stationName,
          tripId: trip.tripId
        });
      }
    }

    arrivals.sort((a, b) => (a.arrivalTimestamp || 0) - (b.arrivalTimestamp || 0));
    const limit = Math.min(args.limit || 5, 10);
    const result = {
      station: validStations[0].stop_name,
      arrivals: arrivals.slice(0, limit),
      count: 0
    };
    result.count = result.arrivals.length;

    return createStandardResponse(result, `Found ${result.arrivals.length} upcoming trains for ${result.station}`);
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

    const trips = (data.entity || []).filter((e: any) => e.tripUpdate && (!line || e.tripUpdate.trip?.routeId === line));

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
  await ensureDataLoaded();
  const stationQuery = args?.station?.trim() || "";
  if (!stationQuery) {
    return createStandardResponse(null, "Please provide a station name.", true);
  }

  try {
    const stopsData = getStopsData();
    const matches = StationMatcher.findBestMatches(stationQuery, stopsData);

    if (matches.length === 0) {
      return createStandardResponse({ query: stationQuery }, `No stations found matching "${stationQuery}"`, true);
    }

    const transfersData = getTransfersData();
    const station = matches[0];
    const stationTransfers = transfersData.filter(t => t.from_stop_id === station.stop_id || t.to_stop_id === station.stop_id);

    const connections = [...new Set(stationTransfers.map(t => {
      const otherId = t.from_stop_id === station.stop_id ? t.to_stop_id : t.from_stop_id;
      return stopsData.find(s => s.stop_id === otherId)?.stop_name;
    }).filter(Boolean))].sort();

    return createStandardResponse({ station: station.stop_name, transfers: connections }, `Found ${connections.length} transfer connections for ${station.stop_name}`);
  } catch (error) {
    return createStandardResponse(null, "Transfer information temporarily unavailable.", true);
  }
}

export async function handleNearestStation(args: NearestStationArgs): Promise<ToolResponse> {
  await ensureDataLoaded();
  if (args?.lat === undefined || args?.lon === undefined) {
    return createStandardResponse(null, "GPS coordinates (lat/lon) are required.", true);
  }

  try {
    const stopsData = getStopsData();
    const radius = args.radius || 1000;
    const limit = args.limit || 5;

    const nearby = stopsData
      .filter(stop => stop.location_type === '1' && stop.stop_lat && stop.stop_lon)
      .map(stop => ({
        name: stop.stop_name,
        stopId: stop.stop_id,
        distance: Math.round(calculateDistance(args.lat!, args.lon!, Number(stop.stop_lat), Number(stop.stop_lon))),
        coordinates: { lat: Number(stop.stop_lat), lon: Number(stop.stop_lon) }
      }))
      .filter(station => station.distance <= radius)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);

    return createStandardResponse(nearby, `Found ${nearby.length} stations within ${radius}m`);
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
      const q = args.station.toLowerCase().trim();
      filtered = filtered.filter(item => item.station.toLowerCase().includes(q));
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
