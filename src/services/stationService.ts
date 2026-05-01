import { GTFSManager } from "./gtfsManager.js";
import type { StationMatch, StationGroup } from "../types/index.js";

let stopsData: any[] = [];
let transfersData: any[] = [];
let routesData: any[] = [];
let lastLoadedAt = 0;
const REFRESH_INTERVAL_MS = 50 * 60 * 1000; // 50 minutes, matches supplemented GTFS TTL

let currentGTFSSource: 'local' | 'supplemented' | 'regular' = 'local';

const MAJOR_HUBS = new Set([
  'times sq-42 st',
  'grand central-42 st',
  '42 st-port authority bus terminal',
  '42 st-bryant pk',
  '14 st-union sq',
  '34 st-herald sq',
  '34 st-penn station',
  '59 st-columbus circle',
  'lexington av/59 st',
  'atlantic av-barclays ctr',
  'fulton st',
  'jay st-metrotech',
  'broadway junction',
]);

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

  static findBestMatches(query: string, stops: any[]): StationMatch[] {
    const normalizedQuery = this.normalizeStationName(query);
    const originalQuery = query.toLowerCase().trim();

    if (!originalQuery) return [];

    const results: StationMatch[] = [];

    for (const stop of stops) {
      if (stop.location_type !== '1') continue;

      const stopNameLower = stop.stop_name?.toLowerCase().trim() ?? '';
      const normalizedStop = this.normalizeStationName(stop.stop_name ?? '');
      const isHub = MAJOR_HUBS.has(stopNameLower);
      const hubBonus = isHub ? 5 : 0;

      let score = 0;
      let matchType: StationMatch['matchType'] | null = null;

      if (stopNameLower === originalQuery) {
        score = 100 + hubBonus;
        matchType = 'exact';
      } else if (normalizedStop === normalizedQuery) {
        score = 90 + hubBonus;
        matchType = 'normalized';
      } else if (normalizedQuery.length > 3) {
        const words = normalizedStop.split(' ');
        if (words.some(word => word === normalizedQuery)) {
          score = 70 + hubBonus;
          matchType = 'partial_word';
        } else if (normalizedStop.startsWith(normalizedQuery)) {
          score = 60 + hubBonus;
          matchType = 'partial_starts';
        } else if (normalizedStop.includes(normalizedQuery)) {
          score = 50 + hubBonus;
          matchType = 'partial_contains';
        }
      }

      if (matchType) {
        results.push({
          stop_id: stop.stop_id,
          stop_name: stop.stop_name,
          score,
          matchType,
          location_type: stop.location_type,
          parent_station: stop.parent_station ?? '',
          stop_lat: stop.stop_lat ?? '',
          stop_lon: stop.stop_lon ?? '',
        });
      }
    }

    // Sort by score desc, then name length asc
    results.sort((a, b) => b.score - a.score || a.stop_name.length - b.stop_name.length);

    return results;
  }

  static groupByName(matches: StationMatch[]): StationGroup[] {
    const groups = new Map<string, StationGroup>();

    for (const match of matches) {
      const existing = groups.get(match.stop_name);
      if (existing) {
        existing.stopIds.push(match.stop_id);
        if (match.score > existing.score) {
          existing.score = match.score;
          existing.matchType = match.matchType;
        }
      } else {
        groups.set(match.stop_name, {
          name: match.stop_name,
          stopIds: [match.stop_id],
          score: match.score,
          matchType: match.matchType,
        });
      }
    }

    return Array.from(groups.values()).sort(
      (a, b) => b.score - a.score || a.name.length - b.name.length
    );
  }
}


export async function ensureDataLoaded() {
  if (lastLoadedAt > 0 && (Date.now() - lastLoadedAt) < REFRESH_INTERVAL_MS) {
    return;
  }

  const isRefresh = lastLoadedAt > 0;

  try {
    try {
      const supplementedData = await GTFSManager.getGTFSData('supplemented');
      stopsData = supplementedData.stops;
      transfersData = supplementedData.transfers;
      routesData = supplementedData.routes;
      currentGTFSSource = 'supplemented';
      lastLoadedAt = Date.now();
      if (isRefresh) {
        console.log(JSON.stringify({ event: "gtfs_refreshed", timestamp: new Date().toISOString(), source: currentGTFSSource }));
      }
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
      lastLoadedAt = Date.now();
      if (isRefresh) {
        console.log(JSON.stringify({ event: "gtfs_refreshed", timestamp: new Date().toISOString(), source: currentGTFSSource }));
      }
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

export function getStopsData(): any[] {
  return stopsData;
}

export function getTransfersData(): any[] {
  return transfersData;
}

export async function getGTFSSourceInfo(): Promise<{ source: string; status: any }> {
  return {
    source: currentGTFSSource,
    status: await GTFSManager.getCacheStatus()
  };
}
