import { GTFSManager } from "./gtfsManager.js";
import type { StationMatch, StationGroup } from "../types/index.js";

let stopsData: any[] = [];
let transfersData: any[] = [];
let stopsById = new Map<string, any>();
let lastLoadedAt = 0;
let lastAttemptAt = 0;
let loading: Promise<void> | null = null;
// The disk cache refreshes weekly; checking daily keeps long-lived Railway processes current
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;

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

// Whole-query nicknames riders use that don't appear in GTFS names
const QUERY_ALIASES: Record<string, string> = {
  'wtc': 'world trade center'
};

export class StationMatcher {
  /**
   * Applied to both the query and GTFS names, so "34th street", "W 4th St" and
   * "Jackson Heights" line up with "34 St", "W 4 St-Wash Sq" and "Jackson Hts".
   */
  static normalizeStationName(name: string): string {
    return name.toLowerCase()
      .trim()
      .replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1')
      .replace(/\bave?\b/g, 'avenue')
      .replace(/\bst\b/g, 'street')
      .replace(/\bpkwy\b/g, 'parkway')
      .replace(/\bblvd\b/g, 'boulevard')
      .replace(/\bsq\b/g, 'square')
      .replace(/\bctr\b/g, 'center')
      .replace(/\bpk\b/g, 'park')
      .replace(/\bhts\b/g, 'heights')
      .replace(/\bwash\b/g, 'washington')
      .replace(/^w\b/, 'west')
      .replace(/^e\b/, 'east')
      .replace(/[\-\/]/g, ' ')
      .replace(/[\(\)]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  static findBestMatches(query: string, stops: any[]): StationMatch[] {
    query = QUERY_ALIASES[query.toLowerCase().trim()] ?? query;
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
      } else if (normalizedQuery.length > 3 || (normalizedQuery.length === 3 && /[a-z]/.test(normalizedQuery))) {
        // Partial matching needs 4+ chars, or 3 letters ("jfk"); bare numbers like "23" would match everything
        const words = normalizedStop.split(' ');
        if (words.some(word => word === normalizedQuery)) {
          score = 70 + hubBonus;
          matchType = 'partial_word';
        } else if (normalizedStop.startsWith(normalizedQuery)) {
          score = 60 + hubBonus;
          matchType = 'partial_starts';
        } else if (` ${normalizedStop}`.includes(` ${normalizedQuery}`)) {
          // Word-start only: "42 street" must not match "Van Cortlandt Park-242 St"
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
          isHub,
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
    return this.groupBy(matches, match => match.stop_name);
  }

  /**
   * One group per station complex, so "23 St" yields four separate stations while
   * Times Sq-42 St and 42 St-Port Authority (one complex) yield one. Name of the
   * best-scoring member is used for the group.
   */
  static groupByComplex(matches: StationMatch[], complexOf: (stopId: string) => string | undefined): StationGroup[] {
    return this.groupBy(matches, match => complexOf(match.stop_id) ?? `name:${match.stop_name}`);
  }

  private static groupBy(matches: StationMatch[], keyOf: (match: StationMatch) => string): StationGroup[] {
    const groups = new Map<string, StationGroup>();

    for (const match of matches) {
      const key = keyOf(match);
      const existing = groups.get(key);
      if (existing) {
        existing.stopIds.push(match.stop_id);
        if (match.score > existing.score) {
          existing.score = match.score;
          existing.matchType = match.matchType;
        }
      } else {
        groups.set(key, {
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


/**
 * Load static GTFS (stops, transfers) once, refresh daily. Concurrent callers share one load.
 * If a refresh fails, previously loaded data keeps being served; only a first load failure throws.
 */
export async function ensureDataLoaded(): Promise<void> {
  const now = Date.now();
  if (lastLoadedAt > 0 && now - lastLoadedAt < REFRESH_INTERVAL_MS) return;
  if (lastLoadedAt > 0 && now - lastAttemptAt < RETRY_AFTER_FAILURE_MS) return;

  loading ??= load().finally(() => { loading = null; });
  return loading;
}

async function load(): Promise<void> {
  const isRefresh = lastLoadedAt > 0;
  lastAttemptAt = Date.now();

  try {
    const { stops, transfers } = await GTFSManager.getGTFSData();
    if (stops.length === 0) throw new Error('stops.txt is empty');

    stopsData = stops;
    transfersData = transfers;
    stopsById = new Map(stops.map(stop => [stop.stop_id, stop]));
    lastLoadedAt = Date.now();

    if (isRefresh) {
      console.log(JSON.stringify({ event: "gtfs_refreshed", timestamp: new Date().toISOString() }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "gtfs_load_failed", timestamp: new Date().toISOString(), servingStale: isRefresh, error: message }));
    if (!isRefresh) {
      throw new Error('GTFS data loading failed');
    }
  }
}

export function getStopsData(): any[] {
  return stopsData;
}

export function getTransfersData(): any[] {
  return transfersData;
}

/** Stop or station name for a GTFS stop ID (platform IDs like "635N" included); falls back to the ID. */
export function getStopName(stopId: string): string {
  return stopsById.get(stopId)?.stop_name ?? stopId;
}
