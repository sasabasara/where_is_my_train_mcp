import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { ensureDataLoaded, getStopsData } from './stationService.js';

interface StationLineCache {
  version: string;
  timestamp: number;
  gtfsSource: 'regular' | 'supplemented';
  stationsCount: number;
  mappings: Record<string, string[]>;
}

// Module-level cache (shared across all Railway clients)
let stationLinesMap: Map<string, string[]> | null = null;
let cacheMetadata: { version: string; timestamp: number; source: string } | null = null;
let isInitialized = false;

/**
 * Ensure station→lines mapping is loaded
 */
export async function ensureStationLineDataLoaded(): Promise<void> {
  if (isInitialized) {
    return;
  }

  console.log('[GTFS Resolver] Initializing station→lines resolver...');
  const startTime = Date.now();

  try {
    // First, ensure GTFS stops/routes are loaded
    await ensureDataLoaded();

    // Try to load from disk cache
    const loaded = await loadFromCache();

    if (loaded) {
      console.log(`[GTFS Resolver] Loaded station→lines from cache in ${Date.now() - startTime}ms (${stationLinesMap?.size || 0} stations)`);
      isInitialized = true;
      return;
    }

    // Cache miss or stale - parse from scratch
    console.log('[GTFS Resolver] Parsing GTFS files (using streaming to save memory)...');
    await buildStationLinesMap();
    await saveToCache();

    console.log(`[GTFS Resolver] Built station→lines mapping in ${Date.now() - startTime}ms (${stationLinesMap?.size || 0} stations)`);
    isInitialized = true;
  } catch (error) {
    console.error('[ERROR] Failed to initialize station→lines resolver:', error);
    console.log('[WARN]  Server will continue with limited fallback functionality');
    // Initialize empty map to prevent crashes
    stationLinesMap = new Map();
    isInitialized = true;
  }
}

export function getLinesByStopId(stopId: string): string[] {
  if (!stationLinesMap) return [];
  const lines = stationLinesMap.get(stopId) || stationLinesMap.get(stopId.replace(/[NS]$/, ''));
  return lines ? [...lines] : [];
}

export function getLinesByStationName(stationName: string): string[] {
  if (!stationLinesMap) return [];
  const stops = getStopsData();
  const normalizedQuery = stationName.toLowerCase().trim();

  const matchingStops = stops.filter(stop => {
    const normalizedStopName = stop.stop_name?.toLowerCase().trim();
    return normalizedStopName === normalizedQuery || normalizedStopName?.includes(normalizedQuery);
  });

  if (matchingStops.length === 0) return [];

  const allLines = new Set<string>();
  for (const stop of matchingStops) {
    getLinesByStopId(stop.stop_id).forEach(line => allLines.add(line));
    if (stop.parent_station) {
      getLinesByStopId(stop.parent_station).forEach(line => allLines.add(line));
    }
  }

  return Array.from(allLines).sort();
}

async function buildStationLinesMap(): Promise<void> {
  const sources = ['gtfs_supplemented', 'gtfs_regular'];
  let sourceUsed = '';

  for (const source of sources) {
    try {
      const result = await tryBuildFromSource(source);
      if (result) {
        sourceUsed = source;
        break;
      }
    } catch (error) {
      console.warn(`[WARN]  Could not build from ${source}:`, error);
    }
  }

  if (!stationLinesMap || stationLinesMap.size === 0) {
    throw new Error('Failed to build station→lines mapping from any GTFS source');
  }

  cacheMetadata = {
    version: `gtfs_${sourceUsed}_${Date.now()}`,
    timestamp: Date.now(),
    source: sourceUsed
  };
}

/**
 * Stream-based CSV parser for large files
 */
async function streamParseCSV(filePath: string, onRow: (row: any) => void): Promise<void> {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let headers: string[] = [];
  let isFirstLine = true;

  for await (const line of rl) {
    const parts = line.split(',').map(p => p.trim().replace(/^"(.*)"$/, '$1'));
    if (isFirstLine) {
      headers = parts;
      isFirstLine = false;
      continue;
    }

    const row: any = {};
    headers.forEach((header, i) => {
      row[header] = parts[i] || '';
    });
    onRow(row);
  }
}

async function tryBuildFromSource(source: string): Promise<boolean> {
  const cacheDir = path.join(process.cwd(), `cache/${source}`);
  const stopTimesPath = path.join(cacheDir, 'stop_times.txt');
  const tripsPath = path.join(cacheDir, 'trips.txt');

  try {
    await fsPromises.access(stopTimesPath);
    await fsPromises.access(tripsPath);
  } catch {
    return false;
  }

  console.log(`[GTFS Resolver] Processing ${source}...`);

  // 1. Build trip_id → route_id mapping (Streaming)
  const tripToRoute = new Map<string, string>();
  await streamParseCSV(tripsPath, (row) => {
    if (row.trip_id && row.route_id) {
      tripToRoute.set(row.trip_id, row.route_id);
    }
  });
  console.log(`  [GTFS Resolver] Loaded ${tripToRoute.size} trips`);

  // 2. Build stop_id → routes mapping (Streaming)
  const mapping = new Map<string, Set<string>>();
  await streamParseCSV(stopTimesPath, (row) => {
    const tripId = row.trip_id;
    const stopId = row.stop_id;
    if (!tripId || !stopId) return;

    const routeId = tripToRoute.get(tripId) || extractRouteFromTripId(tripId);
    if (routeId) {
      if (!mapping.has(stopId)) mapping.set(stopId, new Set());
      mapping.get(stopId)!.add(routeId);
    }
  });

  // Convert to final structure
  stationLinesMap = new Map();
  for (const [stopId, lines] of mapping) {
    stationLinesMap.set(stopId, Array.from(lines).sort());
  }

  return true;
}

function extractRouteFromTripId(tripId: string): string | null {
  const match = tripId.match(/_([A-Z0-9]+)\.\./);
  if (match && match[1] && match[1].length <= 2) return match[1];
  const parts = tripId.split('_');
  if (parts.length > 1) {
    const route = parts[parts.length - 2];
    if (route && route.length <= 2) return route;
  }
  return null;
}

// ... rest of the cache logic (loadFromCache, saveToCache) ...

async function loadFromCache(): Promise<boolean> {
  const cacheFile = path.join(process.cwd(), 'cache/station_lines_cache.json');
  try {
    const data = await fsPromises.readFile(cacheFile, 'utf-8');
    const cache: StationLineCache = JSON.parse(data);
    if (Date.now() - cache.timestamp > 2 * 60 * 60 * 1000) return false;
    stationLinesMap = new Map(Object.entries(cache.mappings));
    cacheMetadata = { version: cache.version, timestamp: cache.timestamp, source: cache.gtfsSource };
    return true;
  } catch { return false; }
}

async function saveToCache(): Promise<void> {
  if (!stationLinesMap || !cacheMetadata) return;
  try {
    const cacheFile = path.join(process.cwd(), 'cache/station_lines_cache.json');
    await fsPromises.mkdir(path.dirname(cacheFile), { recursive: true });
    const cache: StationLineCache = {
      version: cacheMetadata.version,
      timestamp: cacheMetadata.timestamp,
      gtfsSource: cacheMetadata.source as 'regular' | 'supplemented',
      stationsCount: stationLinesMap.size,
      mappings: Object.fromEntries(stationLinesMap)
    };
    await fsPromises.writeFile(cacheFile, JSON.stringify(cache));
  } catch (err) { console.error('Cache save failed:', err); }
}
