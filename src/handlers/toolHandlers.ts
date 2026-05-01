import { fetchMTAData, fetchMTAAlerts, fetchEquipmentOutages } from "../services/mtaService.js";
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
    const alertsResult = await handleSubwayAlerts({
      line: args.line,
      severity: args.severity as SubwayAlertsArgs['severity'],
      active_only: true
    });
    const statusResult = await handleServiceStatus({ line: args.line });

    const analysis = await ServiceDisruptionAnalyzer.analyze(args, alertsResult, statusResult);
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
    const validStationNames = topMatches.map(s => s.stop_name.toLowerCase().trim());
    const data = await fetchMTAData();
    const arrivals: any[] = [];

    for (const entity of data.entity || []) {
      if (!entity.tripUpdate) continue;
      const trip = entity.tripUpdate.trip;
      if (args.line && trip.routeId !== args.line.toUpperCase()) continue;

      for (const update of entity.tripUpdate.stopTimeUpdate || []) {
        const stopRecord = stopsData.find(stop => stop.stop_id === update.stopId);
        const stationName = stopRecord ? stopRecord.stop_name : update.stopId;

        if (validStationNames.includes(stationName.toLowerCase().trim())) {
          arrivals.push({
            line: trip.routeId,
            destination: await getTrainDestination(entity.tripUpdate.stopTimeUpdate),
            arrivalTimestamp: update.arrival?.time ? Number(update.arrival.time) * 1000 : null,
            station: stationName,
            tripId: trip.tripId
          });
        }
      }
    }

    arrivals.sort((a, b) => (a.arrivalTimestamp || 0) - (b.arrivalTimestamp || 0));
    const limit = Math.min(args.limit || 5, 10);
    const result = {
      station: validStations[0].stop_name,
      arrivals: arrivals.slice(0, limit),
      count: arrivals.length
    };

    return createStandardResponse(result, `Found ${result.arrivals.length} upcoming trains for ${result.station}`);
  } catch (error) {
    return createStandardResponse(null, "Train arrival data temporarily unavailable.", true);
  }
}

export async function handleServiceStatus(args: ServiceStatusArgs): Promise<ToolResponse> {
  try {
    const data = await fetchMTAData();
    const alerts = data.entity?.filter((entity: any) => entity.alert) || [];

    const result = {
      activeTrips: data.entity?.filter((e: any) => e.tripUpdate).length || 0,
      totalAlerts: alerts.length,
      topAlerts: alerts.slice(0, 3).map((a: any) => a.alert.headerText?.translation?.[0]?.text)
    };

    return createStandardResponse(result, "System-wide service status overview");
  } catch (error) {
    return createStandardResponse(null, "Service status temporarily unavailable.", true);
  }
}

export async function handleSubwayAlerts(args: SubwayAlertsArgs): Promise<ToolResponse> {
  try {
    const alertsData = await fetchMTAAlerts();
    const alerts = alertsData.entity?.filter((entity: any) => entity.alert) || [];

    let filtered = alerts;
    if (args.line) {
      filtered = filtered.filter((e: any) => e.alert.informedEntity?.some((ie: any) => ie.routeId === args.line?.toUpperCase()));
    }

    const processed = filtered.slice(0, 10).map((e: any) => ({
      header: e.alert.headerText?.translation?.[0]?.text,
      description: e.alert.descriptionText?.translation?.[0]?.text,
      severity: e.alert.severityLevel,
      affectedLines: [...new Set(e.alert.informedEntity?.map((ie: any) => ie.routeId))]
    }));

    return createStandardResponse(processed, `Found ${processed.length} alerts for ${args.line || 'system'}`);
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
    const allEquipment = await fetchEquipmentOutages();
    let filtered = allEquipment;

    if (args.station) {
      const q = args.station.toLowerCase().trim();
      filtered = filtered.filter((item: EquipmentOutage) => item.station.toLowerCase().includes(q));
    }

    if (args.ada_only) {
      filtered = filtered.filter((item: EquipmentOutage) => item.ADA === 'Y');
    }

    const processed = filtered.slice(0, 15).map((item: EquipmentOutage) => ({
      station: item.station,
      lines: item.trainno,
      equipment: item.equipmenttype === 'EL' ? 'Elevator' : 'Escalator',
      reason: item.reason,
      status: item.isupcomingoutage === 'Y' ? 'Upcoming Work' : 'Currently Out'
    }));

    return createStandardResponse(processed, `Found ${processed.length} equipment outages`);
  } catch (error) {
    return createStandardResponse(null, "Elevator and escalator status temporarily unavailable.", true);
  }
}
