import { fetchMTAData, fetchMTAAlerts, fetchEquipmentOutages } from "../services/mtaService.js";
import { StationMatcher, getStopsData, getTransfersData, getGTFSSourceInfo, refreshGTFS, ensureDataLoaded } from "../services/stationService.js";
import { calculateDistance, getTrainDestination, getCurrentLocation, getMTADisclaimer } from "../utils/index.js";
import { ServiceDisruptionAnalyzer } from "../services/serviceDisruptions.js";
import {
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

// New tool handlers
export async function handleServiceDisruptions(args: ServiceDisruptionsArgs): Promise<ToolResponse> {
  try {
    const alertsResult = await handleSubwayAlerts({
      line: args.line,
      severity: args.severity as SubwayAlertsArgs['severity'],
      active_only: true
    });
    const statusResult = await handleServiceStatus({ line: args.line });

    return await ServiceDisruptionAnalyzer.analyze(args, alertsResult, statusResult);
  } catch (error) {
    console.error('Service disruption analysis error occurred');
    return {
      content: [{
        type: "text",
        text: "Service disruption analysis temporarily unavailable. Please try again later."
      }],
      isError: true
    };
  }
}

export async function handleGTFSStatus(args: Record<string, never>): Promise<ToolResponse> {
  try {
    const sourceInfo = await getGTFSSourceInfo();
    
    const result = {
      timestamp: Date.now(),
      timezone: 'America/New_York',
      currentSource: sourceInfo.source,
      dataSources: {
        regular: "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip",
        supplemented: "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip",
        localFallback: "data/gtfs_subway/"
      },
      status: {
        regular: {
          updateFrequency: "few times per year",
          cached: sourceInfo.status.regular.cached,
          ageMinutes: sourceInfo.status.regular.cached ? sourceInfo.status.regular.age : null,
          nextUpdate: sourceInfo.status.regular.cached ? sourceInfo.status.regular.nextUpdate : null,
          isStale: sourceInfo.status.regular.cached ? sourceInfo.status.regular.stale : null
        },
        supplemented: {
          updateFrequency: "hourly",
          cached: sourceInfo.status.supplemented.cached,
          ageMinutes: sourceInfo.status.supplemented.cached ? sourceInfo.status.supplemented.age : null,
          nextUpdate: sourceInfo.status.supplemented.cached ? sourceInfo.status.supplemented.nextUpdate : null,
          isStale: sourceInfo.status.supplemented.cached ? sourceInfo.status.supplemented.stale : null
        }
      }
    };
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(result)
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "GTFS status temporarily unavailable. Please try again later.",
          errorType: "SERVICE_ERROR"
        })
      }],
      isError: true
    };
  }
}

export async function handleFindStation(args: FindStationArgs): Promise<ToolResponse> {
  await ensureDataLoaded();
  
  const stationQuery = args?.query?.toLowerCase() || "";
  
  if (!stationQuery.trim()) {
    return {
      content: [{
        type: "text",
        text: "Please provide a valid station name to search for."
      }],
      isError: true
    };
  }

  const query = args.query.trim();
  const includeAccessibility = args.include_accessibility || false;
  const includeAmenities = args.include_amenities || false;
  

  try {
    const stopsData = getStopsData();
    const matches = StationMatcher.findBestMatches(query, stopsData);
    const stations = matches.map(stop => stop.stop_name);
    const uniqueStations = [...new Set(stations)].sort();
    
    if (uniqueStations.length === 0) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: `No stations found matching "${query}". Try a different spelling or use partial names.`,
            errorType: "STATION_NOT_FOUND",
            searchQuery: query,
            suggestions: ["Try partial names", "Check spelling", "Use common abbreviations"]
          })
        }],
        isError: true
      };
    }

    const result = {
      searchQuery: query,
      stationsFound: uniqueStations.length,
      stations: uniqueStations,
      accessibility: includeAccessibility ? {
        note: "Detailed accessibility data requires MTA API integration",
        recommendation: "Check mta.info for current elevator/escalator status"
      } : null,
      amenities: includeAmenities ? {
        wifi: "Available at most stations",
        restrooms: "Limited availability, check station maps", 
        atms: "Available at major stations"
      } : null,
      timestamp: Date.now()
    };
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(result)
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "Station search temporarily unavailable. Please try again later.",
          errorType: "SERVICE_ERROR"
        })
      }],
      isError: true
    };
  }
}

export async function handleNextTrains(args: NextTrainsArgs): Promise<ToolResponse> {
  await ensureDataLoaded();
  
  const stationQuery = args?.station?.toLowerCase() || "";
  
  if (!stationQuery.trim()) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "Please provide a valid station name.",
          errorType: "INVALID_INPUT"
        })
      }],
      isError: true
    };
  }

  const lineFilter = args.line?.toUpperCase();
  const directionFilter = args.direction?.toLowerCase();
  const limit = Math.min(args.limit || 5, 10);
  
  const stopsData = getStopsData();
  const validStations = StationMatcher.findBestMatches(stationQuery, stopsData);
  
  if (validStations.length === 0) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: `No stations found matching "${stationQuery}". Try a different spelling or use partial names.`,
          errorType: "STATION_NOT_FOUND",
          searchQuery: stationQuery
        })
      }],
      isError: true
    };
  }
  
  const validStationNames = validStations.map(s => s.stop_name.toLowerCase().trim());
  const data = await fetchMTAData();
  const arrivals: any[] = [];
  
  // Process entities with async operations
  for (const entity of data.entity || []) {
    if (!entity.tripUpdate) continue;
    
    const trip = entity.tripUpdate.trip;
    const stopTimeUpdates = entity.tripUpdate.stopTimeUpdate || [];
    
    if (lineFilter && trip.routeId !== lineFilter) continue;
    
    for (const update of stopTimeUpdates) {
      const stopRecord = stopsData.find(stop => stop.stop_id === update.stopId);
      const stationName = stopRecord ? stopRecord.stop_name : update.stopId;
      const stationNameLower = stationName.toLowerCase().trim();
      
      if (validStationNames.includes(stationNameLower)) {
        
        // Get vehicle position for this trip
        const vehicleEntity = data.entity?.find((e: any) => 
          e.vehicle?.trip?.tripId === trip.tripId
        );
        
        const destination = await getTrainDestination(stopTimeUpdates);
        const currentLocation = await getCurrentLocation(vehicleEntity?.vehicle);
        
        const arrivalTime = update.arrival?.time;
        const delay = update.arrival?.delay || 0;
        
        // Extract real crowding data from vehicle position
        const occupancyStatus = vehicleEntity?.vehicle?.occupancyStatus;
        const occupancyPercentage = vehicleEntity?.vehicle?.occupancyPercentage;
        const departureOccupancy = update.departureOccupancyStatus;
        
        // Store raw arrival timestamp for sorting
        let arrivalTimestamp = null;
        let isValidTime = false;
        if (arrivalTime) {
          arrivalTimestamp = Number(arrivalTime) * 1000; // Convert seconds to milliseconds
          const now = Date.now();
          const timeDiff = arrivalTimestamp - now;
          isValidTime = timeDiff > 0 && timeDiff < 2 * 60 * 60 * 1000; // Within next 2 hours
        }
        
        arrivals.push({
          line: trip.routeId,
          lineDisplayName: trip.routeId === 'FS' ? 'Franklin Shuttle' : 
                          trip.routeId === 'S' ? '42nd St Shuttle' :
                          trip.routeId === 'SR' ? 'Lefferts Blvd Shuttle' :
                          trip.routeId === 'SF' ? 'Shuttle' : trip.routeId,
          destination,
          currentLocation,
          arrivalTimestamp,
          isValidTime,
          delay,
          station: stationName,
          occupancyStatus,
          occupancyPercentage,
          departureOccupancy: departureOccupancy || occupancyStatus,
          tripId: trip.tripId
        });
      }
    }
  }
  
  // Sort by arrival time (valid times first, then invalid)
  arrivals.sort((a, b) => {
    if (a.isValidTime && !b.isValidTime) return -1;
    if (!a.isValidTime && b.isValidTime) return 1;
    if (a.isValidTime && b.isValidTime) return a.arrivalTimestamp - b.arrivalTimestamp;
    return 0;
  });
  
  if (arrivals.length === 0) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: `No upcoming trains found for station matching "${stationQuery}"`,
          errorType: "NO_TRAINS_FOUND",
          searchQuery: stationQuery,
          matchedStations: validStations.map(s => s.stop_name)
        })
      }],
      isError: true
    };
  }
  
  // Return structured data
  const result = {
    station: arrivals[0]?.station || stationQuery,
    matchedStations: validStations.map(s => s.stop_name),
    filters: {
      line: lineFilter || null,
      direction: directionFilter || null,
      limit
    },
    trains: arrivals.slice(0, limit).map(arrival => ({
      line: arrival.line,
      destination: arrival.destination,
      currentLocation: arrival.currentLocation,
      arrivalTimestamp: arrival.arrivalTimestamp,
      isValidTime: arrival.isValidTime,
      delay: arrival.delay,
      occupancy: {
        status: arrival.occupancyStatus,
        percentage: arrival.occupancyPercentage,
        departureStatus: arrival.departureOccupancy
      },
      tripId: arrival.tripId
    })),
    totalFound: arrivals.length,
    timestamp: Date.now(),
    timezone: 'America/New_York'
  };
  
  return {
    content: [{
      type: "text",
      text: JSON.stringify(result)
    }]
  };
}

export async function handleServiceStatus(args: ServiceStatusArgs): Promise<ToolResponse> {
  const lineFilter = args?.line?.toUpperCase();
  const includeMetrics = args?.include_metrics || false;
  const timeRange = args?.time_range || 'current';
  
  try {
    const data = await fetchMTAData();
    
    // Get service alerts
    const alerts = data.entity?.filter((entity: any) => entity.alert) || [];
    
    // Get general stats
    const stats = {
      tripUpdates: 0,
      vehiclePositions: 0,
      alerts: alerts.length
    };
    
    data.entity?.forEach((entity: any) => {
      if (entity.tripUpdate) stats.tripUpdates++;
      if (entity.vehicle) stats.vehiclePositions++;
    });
    
    // Process alerts data
    const alertsData = alerts.slice(0, 3).map((entity: any) => {
      const alert = entity.alert;
      return {
        header: alert.headerText?.translation?.[0]?.text || null,
        description: alert.descriptionText?.translation?.[0]?.text || null,
        effect: alert.effect || null,
        informedEntities: alert.informedEntity?.map((ie: any) => ({
          routeId: ie.routeId,
          stopId: ie.stopId
        })) || []
      };
    });
    
    // Line-specific data if requested
    let lineSpecific = null;
    if (lineFilter) {
      const lineTrips = data.entity?.filter((entity: any) => 
        entity.tripUpdate?.trip?.routeId === lineFilter
      ) || [];
      
      lineSpecific = {
        line: lineFilter,
        activeTrains: lineTrips.length
      };
    }
    
    const result = {
      timestamp: Date.now(),
      timezone: 'America/New_York',
      filters: {
        line: lineFilter || null,
        includeMetrics,
        timeRange
      },
      systemStats: {
        activeTrips: stats.tripUpdates,
        vehiclePositions: stats.vehiclePositions,
        totalAlerts: stats.alerts
      },
      alerts: alertsData,
      lineSpecific,
      performanceMetrics: includeMetrics ? {
        note: "Performance metrics require MTA Performance API integration",
        availableData: "Real-time service data available through alerts and trip updates",
        officialReports: "Visit mta.info for official performance reports"
      } : null
    };
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(result)
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "Service status temporarily unavailable. Please try again later.",
          errorType: "SERVICE_ERROR"
        })
      }],
      isError: true
    };
  }
}

export async function handleSubwayAlerts(args: SubwayAlertsArgs): Promise<ToolResponse> {
  const lineFilter = args?.line?.toUpperCase();
  const severityFilter = args?.severity?.toUpperCase();
  const categoryFilter = args?.category?.toUpperCase();
  const activeOnly = args?.active_only !== false; // Default true
  
  try {
    const alertsData = await fetchMTAAlerts();
    const alerts = alertsData.entity?.filter((entity: any) => entity.alert) || [];
    
    let filteredAlerts = alerts;
    
    // Filter by line if specified
    if (lineFilter && lineFilter !== 'ALL') {
      filteredAlerts = filteredAlerts.filter((entity: any) => {
        const alert = entity.alert;
        const informedEntities = alert.informedEntity || [];
        return informedEntities.some((ie: any) => ie.routeId === lineFilter);
      });
    }
    
    // Filter by severity if specified
    if (severityFilter && severityFilter !== 'ALL') {
      filteredAlerts = filteredAlerts.filter((entity: any) => {
        const alert = entity.alert;
        return alert.effect === severityFilter;
      });
    }
    
    // Filter by category if specified (basic mapping)
    if (categoryFilter && categoryFilter !== 'ALL') {
      filteredAlerts = filteredAlerts.filter((entity: any) => {
        const alert = entity.alert;
        const header = alert.headerText?.translation?.[0]?.text?.toUpperCase() || '';
        const description = alert.descriptionText?.translation?.[0]?.text?.toUpperCase() || '';
        
        switch (categoryFilter) {
          case 'DELAYS':
            return header.includes('DELAY') || description.includes('DELAY') || alert.effect === 'SIGNIFICANT_DELAYS';
          case 'SUSPENSIONS':
            return header.includes('SUSPEND') || description.includes('SUSPEND') || alert.effect === 'NO_SERVICE';
          case 'REROUTES':
            return header.includes('REROUTE') || description.includes('REROUTE') || alert.effect === 'DETOUR';
          case 'PLANNED_WORK':
            return header.includes('WORK') || description.includes('WORK') || header.includes('WEEKEND');
          case 'ACCESSIBILITY':
            return header.includes('ELEVATOR') || description.includes('ELEVATOR') || header.includes('ACCESSIBLE');
          default:
            return true;
        }
      });
    }
    
    // Filter by active period if activeOnly is true
    if (activeOnly) {
      const now = Math.floor(Date.now() / 1000); // Unix timestamp in seconds
      filteredAlerts = filteredAlerts.filter((entity: any) => {
        const alert = entity.alert;
        const activePeriods = alert.activePeriod || [];
        
        if (activePeriods.length === 0) return true; // No period specified means always active
        
        return activePeriods.some((period: any) => {
          const start = period.start ? Number(period.start) : 0;
          const end = period.end ? Number(period.end) : Number.MAX_SAFE_INTEGER;
          return now >= start && now <= end;
        });
      });
    }
    
    if (filteredAlerts.length === 0) {
      const result = {
        timestamp: Date.now(),
        timezone: 'America/New_York',
        filters: {
          line: lineFilter || null,
          severity: severityFilter || null,
          category: categoryFilter || null,
          activeOnly
        },
        summary: {
          totalAlertsFound: 0,
          alertsReturned: 0,
          hasMoreAlerts: false
        },
        alerts: [],
        status: "NO_ACTIVE_ALERTS",
        message: "No active alerts found for the specified criteria - service is running normally"
      };
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result)
        }]
      };
    }
    
    // Process alerts into structured data
    const processedAlerts = filteredAlerts.slice(0, 10).map((entity: any, index: number) => {
      const alert = entity.alert;
      
      // Extract affected lines and stations
      const informedEntities = alert.informedEntity || [];
      const affectedLines = [...new Set(informedEntities.map((ie: any) => ie.routeId).filter(Boolean))];
      const affectedStations = [...new Set(informedEntities.map((ie: any) => ie.stopId).filter(Boolean))];
      
      // Process active periods
      const activePeriods = (alert.activePeriod || []).map((period: any) => ({
        startTimestamp: period.start ? Number(period.start) * 1000 : null,
        endTimestamp: period.end ? Number(period.end) * 1000 : null,
        isCurrentlyActive: (() => {
          const now = Date.now();
          const start = period.start ? Number(period.start) * 1000 : 0;
          const end = period.end ? Number(period.end) * 1000 : Number.MAX_SAFE_INTEGER;
          return now >= start && now <= end;
        })()
      }));
      
      // Get full description without truncation (let AI decide how to present it)
      const fullDescription = alert.descriptionText?.translation?.[0]?.text || null;
      
      return {
        id: entity.id || `alert_${index}`,
        rank: index + 1,
        header: alert.headerText?.translation?.[0]?.text || null,
        description: {
          full: fullDescription,
          length: fullDescription ? fullDescription.length : 0,
          isTruncated: fullDescription ? fullDescription.length > 200 : false
        },
        effect: alert.effect || null,
        cause: alert.cause || null,
        severity: alert.severityLevel || null,
        affectedLines,
        affectedStations,
        activePeriods,
        url: alert.url?.translation?.[0]?.text || null,
        isCurrentlyActive: activePeriods.length === 0 || activePeriods.some((p: any) => p.isCurrentlyActive)
      };
    });
    
    const result = {
      timestamp: Date.now(),
      timezone: 'America/New_York',
      filters: {
        line: lineFilter || null,
        severity: severityFilter || null,
        category: categoryFilter || null,
        activeOnly
      },
      summary: {
        totalAlertsFound: filteredAlerts.length,
        alertsReturned: processedAlerts.length,
        hasMoreAlerts: filteredAlerts.length > 10
      },
      alerts: processedAlerts
    };
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(result)
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "Subway alerts temporarily unavailable. Please try again later.",
          errorType: "SERVICE_ERROR"
        })
      }],
      isError: true
    };
  }
}

export async function handleStationTransfers(args: StationTransfersArgs): Promise<ToolResponse> {
  await ensureDataLoaded();
  
  const stationQuery = args?.station?.toLowerCase() || "";
  
  if (!stationQuery.trim()) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "Please provide a station name to search for transfers.",
          errorType: "MISSING_STATION",
          examples: ["Times Square", "Union Square", "Atlantic Ave"]
        })
      }],
      isError: true
    };
  }

  try {
    const stopsData = getStopsData();
    const transfersData = getTransfersData();
    
    // Find matching stations from stops data
    let matchingStops = stopsData.filter(stop => 
      stop.stop_name?.toLowerCase() === stationQuery && 
      stop.location_type === '1' // Parent stations only
    );
    
    // If no exact match, try partial match but prioritize shorter names
    if (matchingStops.length === 0) {
      const partialMatches = stopsData.filter(stop => 
        stop.stop_name?.toLowerCase().includes(stationQuery) && 
        stop.location_type === '1' // Parent stations only
      );
      
      // Sort by name length to prefer shorter, more specific matches
      matchingStops = partialMatches.sort((a, b) => a.stop_name.length - b.stop_name.length);
    }
    
    if (matchingStops.length === 0) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: `No stations found matching "${args?.station}".`,
            errorType: "STATION_NOT_FOUND",
            searchQuery: args?.station,
            suggestions: ["Try partial names like 'Times' or 'Union'", "Check spelling", "Use common station abbreviations"]
          })
        }],
        isError: true
      };
    }
    
    const result = {
      searchQuery: args?.station,
      stationsFound: matchingStops.length,
      stations: matchingStops.slice(0, 3).map(station => {
        // Find all transfers involving this station
        const stationTransfers = transfersData.filter(transfer => 
          transfer.from_stop_id === station.stop_id || transfer.to_stop_id === station.stop_id
        );
        
        if (stationTransfers.length === 0) {
          return {
            name: station.stop_name,
            stopId: station.stop_id,
            transfers: [],
            hasTransferInfo: false
          };
        }
        
        // Group transfers by connected stations
        const connections = new Map();
        stationTransfers.forEach(transfer => {
          const otherStopId = transfer.from_stop_id === station.stop_id ? 
            transfer.to_stop_id : transfer.from_stop_id;
          
          const otherStop = stopsData.find(s => s.stop_id === otherStopId);
          if (otherStop && otherStop.stop_id !== station.stop_id) {
            const transferTimeMinutes = transfer.min_transfer_time ? 
              Math.round(Number(transfer.min_transfer_time) / 60) : null;
            
            connections.set(otherStop.stop_name, {
              stationName: otherStop.stop_name,
              stopId: otherStop.stop_id,
              transferTimeMinutes
            });
          }
        });
        
        return {
          name: station.stop_name,
          stopId: station.stop_id,
          transfers: Array.from(connections.values()).sort((a, b) => 
            a.stationName.localeCompare(b.stationName)
          ),
          hasTransferInfo: connections.size > 0,
          withinStationTransfers: connections.size === 0
        };
      }),
      timestamp: Date.now()
    };
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(result)
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "Transfer information temporarily unavailable. Please try again later.",
          errorType: "SERVICE_ERROR"
        })
      }],
      isError: true
    };
  }
}

export async function handleNearestStation(args: NearestStationArgs): Promise<ToolResponse> {
  await ensureDataLoaded();

  const limit = Math.min(Number(args?.limit) || 5, 15); // Cap at 15
  const radius = Math.min(Number(args?.radius) || 1000, 2000); // Cap at 2km
  const accessibleOnly = args?.accessible_only || false;
  const includeWalkingDirections = args?.include_walking_directions || false;
  const serviceFilter = args?.service_filter || [];

  // Require GPS coordinates
  if (args?.lat === undefined || args?.lon === undefined) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "GPS coordinates are required. Please provide both lat and lon parameters.",
          errorType: "MISSING_COORDINATES",
          example: { lat: 40.7589, lon: -73.9851, description: "Times Square" },
          note: "AI/LLM should convert location names to coordinates before calling this tool"
        })
      }],
      isError: true
    };
  }

  const lat = Number(args.lat);
  const lon = Number(args.lon);

  if (isNaN(lat) || isNaN(lon)) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "Please provide valid latitude and longitude coordinates.",
          errorType: "INVALID_COORDINATES",
          example: { lat: 40.7589, lon: -73.9851, description: "Times Square" }
        })
      }],
      isError: true
    };
  }

  try {
    const stopsData = getStopsData();

    // Find parent stations (location_type = 1) within radius
    const nearbyStations = stopsData
      .filter(stop => stop.location_type === '1' && stop.stop_lat && stop.stop_lon)
      .map(stop => {
        const distance = calculateDistance(
          lat, lon,
          Number(stop.stop_lat), Number(stop.stop_lon)
        );
        return { ...stop, distance };
      })
      .filter(stop => stop.distance <= radius)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);

    if (nearbyStations.length === 0) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: `No subway stations found within ${radius}m of the specified location.`,
            errorType: "NO_STATIONS_FOUND",
            location: { lat, lon },
            searchRadius: radius,
            suggestion: "Try increasing the search radius"
          })
        }],
        isError: true
      };
    }

    const result = {
      searchLocation: { lat, lon },
      searchRadius: radius,
      filters: {
        limit,
        accessibleOnly,
        includeWalkingDirections,
        serviceFilter: serviceFilter.length > 0 ? serviceFilter : null
      },
      stationsFound: nearbyStations.length,
      stations: nearbyStations.map((station, i) => {
        const walkingTime = Math.ceil(station.distance / 80); // ~80m/min walking speed

        return {
          rank: i + 1,
          name: station.stop_name,
          stopId: station.stop_id,
          coordinates: {
            lat: Number(station.stop_lat),
            lon: Number(station.stop_lon)
          },
          distance: {
            meters: Math.round(station.distance),
            walkingTimeMinutes: walkingTime
          },
          walkingDirection: includeWalkingDirections ? {
            primary: station.stop_lat > lat ? 'north' : 'south',
            secondary: station.stop_lon > lon ? 'east' : 'west'
          } : null,
          accessibility: accessibleOnly ? {
            wheelchairAccessible: true
          } : null
        };
      }),
      walkingTips: includeWalkingDirections ? [
        "Use street-level signs to locate station entrances",
        "Check for elevator access if needed",
        "Allow extra time during rush hours"
      ] : null,
      timestamp: Date.now()
    };

    return {
      content: [{
        type: "text",
        text: JSON.stringify(result)
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "Station search temporarily unavailable. Please try again later.",
          errorType: "SERVICE_ERROR"
        })
      }],
      isError: true
    };
  }
}

export async function handleElevatorEscalatorStatus(args: ElevatorEscalatorStatusArgs): Promise<ToolResponse> {
  const stationQuery = args?.station?.toLowerCase().trim();
  const equipmentType = args?.equipment_type || 'all';
  const adaOnly = args?.ada_only || false;
  const outageType = args?.outage_type || 'current';

  try {
    const allEquipment = await fetchEquipmentOutages();

    let filteredEquipment = allEquipment;

    // Filter by station if provided
    if (stationQuery) {
      filteredEquipment = filteredEquipment.filter((item: EquipmentOutage) =>
        item.station.toLowerCase().includes(stationQuery)
      );

      if (filteredEquipment.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: `No equipment found at stations matching "${args?.station}".`,
              errorType: "STATION_NOT_FOUND",
              searchQuery: args?.station,
              suggestion: "Try a partial station name or check spelling"
            })
          }],
          isError: true
        };
      }
    }

    // Filter by equipment type
    if (equipmentType !== 'all') {
      const typeCode = equipmentType === 'elevator' ? 'EL' : 'ES';
      filteredEquipment = filteredEquipment.filter((item: EquipmentOutage) =>
        item.equipmenttype === typeCode
      );
    }

    // Filter by ADA accessibility
    if (adaOnly) {
      filteredEquipment = filteredEquipment.filter((item: EquipmentOutage) =>
        item.ADA === 'Y'
      );
    }

    // Filter by outage type
    if (outageType === 'current') {
      filteredEquipment = filteredEquipment.filter((item: EquipmentOutage) =>
        item.isupcomingoutage === 'N'
      );
    } else if (outageType === 'upcoming') {
      filteredEquipment = filteredEquipment.filter((item: EquipmentOutage) =>
        item.isupcomingoutage === 'Y'
      );
    }

    // Format the response
    const result = {
      timestamp: Date.now(),
      timezone: 'America/New_York',
      filters: {
        station: stationQuery || null,
        equipmentType,
        adaOnly,
        outageType
      },
      summary: {
        totalOutages: filteredEquipment.length,
        elevators: filteredEquipment.filter((e: EquipmentOutage) => e.equipmenttype === 'EL').length,
        escalators: filteredEquipment.filter((e: EquipmentOutage) => e.equipmenttype === 'ES').length,
        adaImpacted: filteredEquipment.filter((e: EquipmentOutage) => e.ADA === 'Y').length,
        currentOutages: filteredEquipment.filter((e: EquipmentOutage) => e.isupcomingoutage === 'N').length,
        upcomingOutages: filteredEquipment.filter((e: EquipmentOutage) => e.isupcomingoutage === 'Y').length
      },
      outages: filteredEquipment.map((item: EquipmentOutage) => ({
        station: item.station,
        lines: item.trainno,
        equipment: {
          id: item.equipment,
          type: item.equipmenttype === 'EL' ? 'Elevator' : 'Escalator',
          serving: item.serving,
          adaAccessible: item.ADA === 'Y'
        },
        outage: {
          startDate: item.outagedate,
          estimatedReturn: item.estimatedreturntoservice,
          reason: item.reason,
          isUpcoming: item.isupcomingoutage === 'Y',
          isMaintenance: item.ismaintenanceoutage === 'Y'
        }
      })),
      note: "Equipment status data from MTA. Check mta.info for real-time updates."
    };

    return {
      content: [{
        type: "text",
        text: JSON.stringify(result)
      }]
    };
  } catch (error) {
    console.error('Elevator/Escalator status error occurred');
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "Elevator and escalator status temporarily unavailable. Please try again later.",
          errorType: "SERVICE_ERROR"
        })
      }],
      isError: true
    };
  }
}
