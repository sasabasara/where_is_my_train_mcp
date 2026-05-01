import { ensureDataLoaded, getStopsData } from './stationService.js';
import { Stop } from '../types/index.js';

export class StationMapper {
  private stopsMap = new Map<string, Stop>();
  private loaded = false;

  constructor() {}

  private async loadStops() {
    if (this.loaded) return;

    try {
      // Use lazy-loaded GTFS data from stationService
      // This avoids duplicate GTFS loading and reduces memory usage
      await ensureDataLoaded();
      const stopsData = getStopsData();
      
      // Convert to Stop objects and populate map
      for (const stopData of stopsData) {
        const stop: Stop = {
          stop_id: stopData.stop_id,
          stop_name: stopData.stop_name,
          stop_lat: parseFloat(stopData.stop_lat),
          stop_lon: parseFloat(stopData.stop_lon),
          location_type: stopData.location_type,
          parent_station: stopData.parent_station
        };
        this.stopsMap.set(stop.stop_id, stop);
      }
      
      this.loaded = true;
    } catch (error) {
      console.warn('⚠️  Could not load station mappings:', error);
    }
  }

  async getStationName(stopId: string): Promise<string> {
    await this.loadStops();
    const stop = this.stopsMap.get(stopId);
    return stop ? stop.stop_name : stopId;
  }

  getDirection(stopId: string): string {
    if (stopId.endsWith('N')) return 'Northbound';
    if (stopId.endsWith('S')) return 'Southbound';
    return 'Unknown';
  }

  getDirectionFromTripId(tripId: string): string {
    const match = tripId.match(/_([NS])\.\./);
    if (match) {
      return match[1] === 'N' ? 'Northbound' : 'Southbound';
    }
    return 'Unknown';
  }

  async formatStopInfo(stopId: string): Promise<string> {
    const stationName = await this.getStationName(stopId);
    const direction = this.getDirection(stopId);
    return `${stationName} (${direction})`;
  }
}
