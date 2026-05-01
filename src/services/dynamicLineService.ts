import { fetchMTAData } from './mtaService.js';
import { getLinesByStationName, ensureStationLineDataLoaded } from './gtfsLineResolver.js';

interface StationLineInfo {
  stationName: string;
  activeLines: string[];
  lastUpdated: Date;
}

export class DynamicLineService {
  /**
   * Get currently active lines at a station based on real-time MTA data
   * No caching - relies on upstream MTA data caching for performance
   */
  static async getActiveLinesAtStation(stationName: string): Promise<string[]> {
    const normalizedName = stationName.toLowerCase().trim();
    
    try {
      // Get real-time data
      const mtaData = await fetchMTAData();
      const activeLines = new Set<string>();
      
      // Extract active lines from trip updates and vehicle positions
      mtaData.entity?.forEach((entity: any) => {
        if (entity.tripUpdate?.trip?.routeId) {
          const routeId = entity.tripUpdate.trip.routeId;
          
          // Check if this trip serves the requested station
          const stopUpdates = entity.tripUpdate.stopTimeUpdate || [];
          const servesStation = stopUpdates.some((update: any) => 
            this.matchesStation(update.stopId, normalizedName)
          );
          
          if (servesStation) {
            activeLines.add(routeId);
          }
        }
        
        if (entity.vehicle?.trip?.routeId) {
          const routeId = entity.vehicle.trip.routeId;
          // Vehicle position indicates active service
          activeLines.add(routeId);
        }
      });
      
      const linesArray = Array.from(activeLines).sort();
      return linesArray;
      
    } catch (error) {
      console.warn(`Failed to get dynamic lines for ${stationName}:`, error);

      // Final fallback to GTFS-derived data
      return await this.getFallbackLinesForStation(stationName);
    }
  }
  
  /**
   * Get active lines for multiple stations (for landmarks with multiple access points)
   */
  static async getActiveLinesAtStations(stationNames: string[]): Promise<string[]> {
    const allLines = new Set<string>();
    
    for (const station of stationNames) {
      const lines = await this.getActiveLinesAtStation(station);
      lines.forEach(line => allLines.add(line));
    }
    
    return Array.from(allLines).sort();
  }
  
  /**
   * Check if current time is weekend (affects service patterns)
   */
  static isWeekend(): boolean {
    const now = new Date();
    const day = now.getDay();
    return day === 0 || day === 6; // Sunday = 0, Saturday = 6
  }
  
  /**
   * Get service context (weekday/weekend, time of day)
   * Late night hours based on official MTA definition: midnight to 6:00 AM
   */
  static getServiceContext(): { isWeekend: boolean; timeOfDay: string; serviceNote: string } {
    const now = new Date();
    const hour = now.getHours();
    const isWeekend = this.isWeekend();
    
    let timeOfDay = 'daytime';
    if (hour >= 0 && hour < 6) timeOfDay = 'late_night'; // MTA official: midnight to 6:00 AM
    else if (hour >= 6 && hour < 10) timeOfDay = 'morning_rush';
    else if (hour >= 10 && hour < 16) timeOfDay = 'midday';
    else if (hour >= 16 && hour < 20) timeOfDay = 'evening_rush';
    else if (hour >= 20) timeOfDay = 'evening';
    
    let serviceNote = '';
    if (isWeekend) {
      serviceNote = '🗓️ Weekend service - some lines may have modified routes or reduced frequency';
    } else if (timeOfDay === 'late_night') {
      serviceNote = '🌙 Late night service (midnight-6AM) - limited trains and modified routes';
    }
    
    return { isWeekend, timeOfDay, serviceNote };
  }
  
  /**
   * Match stop ID to station name (handles complex MTA stop ID system)
   */
  private static matchesStation(stopId: string, targetStation: string): boolean {
    if (!stopId) return false;
    
    // MTA stop IDs are complex - try multiple matching strategies
    const stopIdLower = stopId.toLowerCase();
    const target = targetStation.toLowerCase();
    
    // Direct match
    if (stopIdLower.includes(target) || target.includes(stopIdLower)) {
      return true;
    }
    
    // Try matching against known station mappings
    // This would need to be expanded with actual MTA stop ID mappings
    const stationMappings = new Map([
      ['times sq', ['times', '42', 'port authority']],
      ['union sq', ['union', '14']],
      ['grand central', ['grand', 'central', '42']],
      ['penn station', ['penn', '34']],
    ]);
    
    for (const [station, keywords] of stationMappings) {
      if (target.includes(station)) {
        return keywords.some(keyword => stopIdLower.includes(keyword));
      }
    }
    
    return false;
  }
  
  /**
   * Fallback to GTFS-derived line data when real-time fails
   * Uses accurate data from stop_times.txt for all 472 NYC stations
   */
  private static async getFallbackLinesForStation(stationName: string): Promise<string[]> {
    try {
      // Ensure GTFS line resolver is initialized
      await ensureStationLineDataLoaded();

      // Get lines from GTFS-derived mapping
      const gtfsLines = getLinesByStationName(stationName);

      if (gtfsLines.length > 0) {
        return gtfsLines;
      }

      // Minimal override map for exceptional cases only
      // (Only use if GTFS data is known to be incomplete for specific stations)
      const overrides = new Map<string, string[]>([
        // Currently empty - GTFS data should be complete
        // Add entries only if specific stations have known data issues
      ]);

      const normalized = stationName.toLowerCase();
      for (const [station, lines] of overrides) {
        if (normalized.includes(station) || station.includes(normalized)) {
          return lines;
        }
      }

      return [];
    } catch (error) {
      console.error('Failed to get fallback lines:', error);
      return [];
    }
  }
  
}
