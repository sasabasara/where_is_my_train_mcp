import { GTFSManager } from "./gtfsManager.js";

let stopsData: any[] = [];
let transfersData: any[] = [];
let routesData: any[] = [];
let isDataLoaded = false;

let currentGTFSSource: 'local' | 'supplemented' | 'regular' = 'local';

export class StationMatcher {
  static normalizeStationName(name: string): string {
    return name.toLowerCase()
      .trim()
      .replace(/\bav\b/g, 'avenue')
      .replace(/\bst\b/g, 'street')
      .replace(/\bpkwy\b/g, 'parkway')
      .replace(/\bblvd\b/g, 'boulevard')
      .replace(/\bsq\b/g, 'square')
      .replace(/[\-\/]/g, ' ')
      .replace(/[\(\)]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  static findBestMatches(query: string, stops: any[]): any[] {
    const normalizedQuery = this.normalizeStationName(query);
    const originalQuery = query.toLowerCase().trim();
    
    let matches = stops.filter(stop => 
      stop.stop_name?.toLowerCase().trim() === originalQuery &&
      stop.location_type === '1'
    );
    
    if (matches.length === 0) {
      matches = stops.filter(stop => 
        this.normalizeStationName(stop.stop_name) === normalizedQuery &&
        stop.location_type === '1'
      );
    }
    
    if (matches.length > 1) {
      const majorHubs = [
        'times sq-42 st', 'grand central-42 st', '42 st-port authority bus terminal',
        '42 st-bryant pk', 'union sq-14 st', '14 st-union sq', 'herald sq-34 st',
        'penn station-34 st', 'columbus circle-59 st', 'lexington av-59 st'
      ];
      
      const hubMatches = matches.filter(stop => 
        majorHubs.includes(stop.stop_name.toLowerCase())
      );
      
      if (hubMatches.length > 0) {
        matches = hubMatches;
      }
    }
    
    if (matches.length === 0 && normalizedQuery.length > 3) {
      const partialMatches = stops.filter(stop => {
        const normalizedStopName = this.normalizeStationName(stop.stop_name);
        return normalizedStopName.includes(normalizedQuery) &&
               stop.location_type === '1';
      });
      
      // Prioritize exact word matches over partial matches
      const exactWordMatches = partialMatches.filter(stop => {
        const normalizedStopName = this.normalizeStationName(stop.stop_name);
        const words = normalizedStopName.split(' ');
        return words.some(word => word === normalizedQuery);
      });
      
      if (exactWordMatches.length > 0) {
        matches = exactWordMatches;
      } else {
        matches = partialMatches.sort((a, b) => {
          const aNorm = this.normalizeStationName(a.stop_name);
          const bNorm = this.normalizeStationName(b.stop_name);
          
          const aStarts = aNorm.startsWith(normalizedQuery);
          const bStarts = bNorm.startsWith(normalizedQuery);
          
          if (aStarts && !bStarts) return -1;
          if (!aStarts && bStarts) return 1;
          
          return a.stop_name.length - b.stop_name.length;
        });
      }
    }
    
    return matches;
  }
}


export async function ensureDataLoaded() {
  if (isDataLoaded) {
    return;
  }
  
  try {
    try {
      const supplementedData = await GTFSManager.getGTFSData('supplemented');
      stopsData = supplementedData.stops;
      transfersData = supplementedData.transfers;
      routesData = supplementedData.routes;
      currentGTFSSource = 'supplemented';
      isDataLoaded = true;
      return;
    } catch (error) {
      console.warn('Supplemented GTFS unavailable, trying regular GTFS:', error);
    }

    try {
      const regularData = await GTFSManager.getGTFSData('regular');
      stopsData = regularData.stops;
      transfersData = regularData.transfers;
      routesData = regularData.routes;
      currentGTFSSource = 'regular';
      isDataLoaded = true;
      return;
    } catch (error) {
      console.error('Regular GTFS unavailable');
      throw new Error('Failed to load GTFS data from both supplemented and regular sources');
    }
  } catch (error) {
    console.error('Error loading GTFS data occurred');
    throw new Error('GTFS data loading failed');
  }
}

// Keep the old function for backward compatibility
export async function loadStaticGTFS() {
  return ensureDataLoaded();
}


export function getStopsData(): any[] {
  return stopsData;
}

export function getTransfersData(): any[] {
  return transfersData;
}

export function getRoutesData(): any[] {
  return routesData;
}

export async function getGTFSSourceInfo(): Promise<{ source: string; status: any }> {
  return {
    source: currentGTFSSource,
    status: await GTFSManager.getCacheStatus()
  };
}

export async function refreshGTFS(type?: 'regular' | 'supplemented'): Promise<void> {
  if (type) {
    await GTFSManager.forceRefresh(type);
  } else {
    await GTFSManager.forceRefresh('supplemented');
    await GTFSManager.forceRefresh('regular');
  }
  
  isDataLoaded = false; // Force reload
  await ensureDataLoaded();
}

export function clearGTFSData() {
  stopsData = [];
  transfersData = [];
  routesData = [];
  isDataLoaded = false;
  currentGTFSSource = 'local';
}
