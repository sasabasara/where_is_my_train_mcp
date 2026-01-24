import fs from 'fs/promises';
import path from 'path';
import { parseCSV } from '../utils/csvParser.js';
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
 * Called once at server startup or first API request
 * Shared across all MCP clients connected to Railway server
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
    console.log('[GTFS Resolver] Parsing stop_times.txt (this may take 10-30 seconds)...');
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

/**
 * Get lines serving a specific stop_id
 * O(1) lookup from in-memory Map
 */
export function getLinesByStopId(stopId: string): string[] {
  if (!stationLinesMap) {
    console.warn('[WARN]  Station lines not initialized, returning empty array');
    return [];
  }

  // Try exact match first
  const lines = stationLinesMap.get(stopId);
  if (lines && lines.length > 0) {
    return [...lines]; // Return copy to prevent mutation
  }

  // Try parent station (remove direction suffix N/S)
  const parentId = stopId.replace(/[NS]$/, '');
  if (parentId !== stopId) {
    const parentLines = stationLinesMap.get(parentId);
    if (parentLines && parentLines.length > 0) {
      return [...parentLines];
    }
  }

  return [];
}

/**
 * Get lines serving a station by name
 * Handles multiple stops with same name (e.g., all "23 St" stations)
 * Aggregates lines from all matching stops
 */
export function getLinesByStationName(stationName: string): string[] {
  if (!stationLinesMap) {
    console.warn('[WARN]  Station lines not initialized, returning empty array');
    return [];
  }

  const stops = getStopsData();
  const normalizedQuery = stationName.toLowerCase().trim();

  // Find all stops matching this name
  const matchingStops = stops.filter(stop => {
    const normalizedStopName = stop.stop_name?.toLowerCase().trim();
    return normalizedStopName === normalizedQuery ||
           normalizedStopName?.includes(normalizedQuery);
  });

  if (matchingStops.length === 0) {
    return [];
  }

  // Aggregate lines from all matching stops
  const allLines = new Set<string>();

  for (const stop of matchingStops) {
    // Check this stop
    const stopLines = getLinesByStopId(stop.stop_id);
    stopLines.forEach(line => allLines.add(line));

    // Also check parent station if exists
    if (stop.parent_station) {
      const parentLines = getLinesByStopId(stop.parent_station);
      parentLines.forEach(line => allLines.add(line));
    }
  }

  return Array.from(allLines).sort();
}

/**
 * Build the station→lines mapping by parsing stop_times.txt
 * This is the heavy operation that runs once at startup
 */
async function buildStationLinesMap(): Promise<void> {
  // Try supplemented first (more up-to-date), fallback to regular
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
 * Try to build mapping from a specific GTFS source
 */
async function tryBuildFromSource(source: string): Promise<boolean> {
  const cacheDir = path.join(process.cwd(), `cache/${source}`);
  const stopTimesPath = path.join(cacheDir, 'stop_times.txt');
  const tripsPath = path.join(cacheDir, 'trips.txt');

  // Check if files exist
  try {
    await fs.access(stopTimesPath);
    await fs.access(tripsPath);
  } catch {
    console.log(`[INFO]  ${source} files not found, trying next source...`);
    return false;
  }

  console.log(`[GTFS Resolver] Using ${source} for station→lines mapping`);

  // Build trip_id → route_id mapping from trips.txt
  console.log('  [GTFS Resolver] Parsing trips.txt...');
  const tripToRoute = await buildTripToRouteMap(tripsPath);
  console.log(`  [GTFS Resolver] Loaded ${tripToRoute.size} trip→route mappings`);

  // Parse stop_times.txt and aggregate
  console.log('  [GTFS Resolver] Parsing stop_times.txt (this is the slow part)...');
  const content = await fs.readFile(stopTimesPath, 'utf-8');
  const rows = parseCSV(content);
  console.log(`  [GTFS Resolver] Parsed ${rows.length} stop time entries`);

  // Aggregate stop_id → lines
  const mapping = new Map<string, Set<string>>();
  let processedCount = 0;

  for (const row of rows) {
    const tripId = row.trip_id;
    const stopId = row.stop_id;

    if (!tripId || !stopId) continue;

    // Get route from trip_id mapping
    const routeId = tripToRoute.get(tripId);

    if (!routeId) {
      // Try to extract from trip_id as fallback
      const extracted = extractRouteFromTripId(tripId);
      if (extracted) {
        if (!mapping.has(stopId)) {
          mapping.set(stopId, new Set());
        }
        mapping.get(stopId)!.add(extracted);
      }
      continue;
    }

    // Add to mapping
    if (!mapping.has(stopId)) {
      mapping.set(stopId, new Set());
    }
    mapping.get(stopId)!.add(routeId);

    processedCount++;
  }

  console.log(`  [GTFS Resolver] Processed ${processedCount} valid stop→line associations`);

  // Convert Sets to sorted arrays
  stationLinesMap = new Map();
  for (const [stopId, lines] of mapping) {
    stationLinesMap.set(stopId, Array.from(lines).sort());
  }

  console.log(`  [GTFS Resolver] Built mapping for ${stationLinesMap.size} unique stops`);

  return true;
}

/**
 * Build trip_id → route_id mapping from trips.txt
 * This tells us which route each trip belongs to
 */
async function buildTripToRouteMap(tripsPath: string): Promise<Map<string, string>> {
  const mapping = new Map<string, string>();

  try {
    const content = await fs.readFile(tripsPath, 'utf-8');
    const rows = parseCSV(content);

    for (const row of rows) {
      if (row.trip_id && row.route_id) {
        mapping.set(row.trip_id, row.route_id);
      }
    }
  } catch (error) {
    console.warn('[WARN]  Could not parse trips.txt:', error);
  }

  return mapping;
}

/**
 * Extract route_id from trip_id (MTA naming convention)
 * Used as fallback when trips.txt mapping fails
 * Example: "AFA23GEN-1037-Sunday-00_000200_1..S03R" → "1"
 */
function extractRouteFromTripId(tripId: string): string | null {
  if (!tripId) return null;

  // MTA trip_id format often contains route info
  // Pattern 1: ..._<route>..
  const match1 = tripId.match(/_([A-Z0-9]+)\.\./);
  if (match1 && match1[1]) {
    const route = match1[1];
    // Validate it looks like a route (1-2 chars/digits)
    if (/^[A-Z0-9]{1,2}$/.test(route)) {
      return route;
    }
  }

  // Pattern 2: Extract from parts
  const parts = tripId.split('_');
  if (parts.length > 1) {
    const routePart = parts[parts.length - 2];
    if (routePart && /^[A-Z0-9]{1,2}$/.test(routePart)) {
      return routePart;
    }
  }

  return null;
}

/**
 * Load station→lines mapping from disk cache
 * Returns true if cache is valid and loaded
 */
async function loadFromCache(): Promise<boolean> {
  const cacheFile = path.join(process.cwd(), 'cache/station_lines_cache.json');

  try {
    const data = await fs.readFile(cacheFile, 'utf-8');
    const cache: StationLineCache = JSON.parse(data);

    // Check if cache is stale (> 2 hours)
    const age = Date.now() - cache.timestamp;
    const maxAge = 2 * 60 * 60 * 1000; // 2 hours

    if (age > maxAge) {
      console.log(`[WARN]  Cache is ${Math.round(age / 1000 / 60)} minutes old, rebuilding...`);
      return false;
    }

    // Check if cache has data
    if (!cache.mappings || Object.keys(cache.mappings).length === 0) {
      console.log('[WARN]  Cache is empty, rebuilding...');
      return false;
    }

    // Load into memory
    stationLinesMap = new Map(Object.entries(cache.mappings));
    cacheMetadata = {
      version: cache.version,
      timestamp: cache.timestamp,
      source: cache.gtfsSource
    };

    console.log(`[INFO]  Cache age: ${Math.round(age / 1000 / 60)} minutes, ${cache.stationsCount} stations`);

    return true;
  } catch (error) {
    console.log('[INFO]  No valid cache found, will build from scratch');
    return false;
  }
}

/**
 * Save station→lines mapping to disk cache
 * Enables fast server restarts
 */
async function saveToCache(): Promise<void> {
  if (!stationLinesMap || !cacheMetadata) {
    console.warn('[WARN]  Cannot save cache: no data available');
    return;
  }

  try {
    const cacheFile = path.join(process.cwd(), 'cache/station_lines_cache.json');
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });

    const cache: StationLineCache = {
      version: cacheMetadata.version,
      timestamp: cacheMetadata.timestamp,
      gtfsSource: cacheMetadata.source as 'regular' | 'supplemented',
      stationsCount: stationLinesMap.size,
      mappings: Object.fromEntries(stationLinesMap)
    };

    await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2));
    console.log('[GTFS Resolver] Saved station→lines cache to disk');
  } catch (error) {
    console.error('[ERROR] Failed to save cache:', error);
    // Non-fatal - server can continue without cache
  }
}

/**
 * Get cache status for monitoring and debugging
 */
export function getStationLineCacheStatus() {
  return {
    initialized: isInitialized,
    stationsCount: stationLinesMap?.size || 0,
    version: cacheMetadata?.version || null,
    source: cacheMetadata?.source || null,
    ageMinutes: cacheMetadata ? Math.round((Date.now() - cacheMetadata.timestamp) / 1000 / 60) : null
  };
}

/**
 * Force rebuild of the cache (for debugging or manual refresh)
 */
export async function rebuildStationLineCache(): Promise<void> {
  console.log('🔄 Forcing rebuild of station→lines cache...');
  stationLinesMap = null;
  cacheMetadata = null;
  isInitialized = false;
  await ensureStationLineDataLoaded();
}
