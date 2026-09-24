import fs from 'fs/promises';
import path from 'path';
import type { StationInfo } from '../types/index.js';

// MTA Subway Stations (data.ny.gov). One row per GTFS parent station; gtfs_stop_id matches
// stops.txt parent stop_ids exactly (496/496 as of 2026-09). Adds what GTFS lacks:
// station complexes, platform direction labels, ADA status, and daytime routes.
const STATIONS_URL = 'https://data.ny.gov/resource/39hk-dx4f.json?$limit=5000';
const CACHE_FILE = path.join(process.cwd(), 'cache/stations/stations.json');
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let byStopId = new Map<string, StationInfo>();
let byComplexId = new Map<string, StationInfo[]>();
let loadedAt = 0;
let loading: Promise<void> | null = null;

const ADA_LEVELS: Record<string, StationInfo['accessibility']> = { '0': 'none', '1': 'full', '2': 'partial' };

function toStationInfo(row: any): StationInfo {
  return {
    stopId: row.gtfs_stop_id,
    complexId: row.complex_id,
    name: row.stop_name,
    borough: row.borough,
    routes: (row.daytime_routes ?? '').split(' ').filter(Boolean),
    northLabel: row.north_direction_label || 'Northbound',
    southLabel: row.south_direction_label || 'Southbound',
    accessibility: ADA_LEVELS[row.ada] ?? 'none',
    accessibilityNotes: row.ada_notes || null,
    lat: Number(row.gtfs_latitude),
    lon: Number(row.gtfs_longitude)
  };
}

export function setStations(rows: any[]): void {
  const stations = rows.filter(r => r.gtfs_stop_id).map(toStationInfo);
  byStopId = new Map(stations.map(s => [s.stopId, s]));
  byComplexId = new Map();
  for (const s of stations) {
    const list = byComplexId.get(s.complexId) ?? [];
    list.push(s);
    byComplexId.set(s.complexId, list);
  }
}

async function readCache(): Promise<{ fetchedAt: number; rows: any[] } | null> {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

async function load(): Promise<void> {
  const cached = await readCache();
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    setStations(cached.rows);
    loadedAt = cached.fetchedAt;
    return;
  }

  try {
    const res = await fetch(STATIONS_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('Invalid stations data');

    setStations(rows);
    loadedAt = Date.now();
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify({ fetchedAt: loadedAt, rows }));
  } catch (error) {
    console.error('Failed to fetch MTA stations list:', error instanceof Error ? error.message : error);
    // Stale cache beats nothing; with neither, callers fall back to plain GTFS behaviour
    if (cached) {
      setStations(cached.rows);
    }
    // Retry in an hour rather than on every request
    loadedAt = Date.now() - CACHE_TTL_MS + 60 * 60 * 1000;
  }
}

export async function ensureStationInfoLoaded(): Promise<void> {
  if (loadedAt > 0 && Date.now() - loadedAt < CACHE_TTL_MS) return;
  loading ??= load().finally(() => { loading = null; });
  return loading;
}

export function getStationInfo(stopId: string): StationInfo | undefined {
  return byStopId.get(stopId.replace(/[NS]$/, ''));
}

/** All stations in the same complex (connected by free transfers), including the given one. */
export function getComplexStations(stopId: string): StationInfo[] {
  const info = getStationInfo(stopId);
  if (!info) return [];
  return byComplexId.get(info.complexId) ?? [info];
}

/** Daytime routes across a whole complex, e.g. Times Sq → 1 2 3 7 A C E N Q R W S. */
export function getComplexRoutes(stopId: string): string[] {
  return sortRoutes([...new Set(getComplexStations(stopId).flatMap(s => s.routes))]);
}

export function sortRoutes(routes: string[]): string[] {
  return [...routes].sort((a, b) => {
    const an = /^\d/.test(a), bn = /^\d/.test(b);
    if (an !== bn) return an ? -1 : 1;
    return a.localeCompare(b, 'en', { numeric: true });
  });
}

/**
 * Whether a GTFS-RT route_id belongs to a user-facing line name.
 * "6" also matches the 6X express; "S" matches the three shuttles (GS/FS/H); "SIR" matches SI.
 */
export function routeMatchesLine(routeId: string | undefined, line: string): boolean {
  if (!routeId) return false;
  const l = line.trim().toUpperCase();
  const r = routeId.toUpperCase();
  if (r === l || r === `${l}X`) return true;
  if (l === 'S') return ['GS', 'FS', 'H'].includes(r);
  if (l === 'SIR' || l === 'SI') return r === 'SI';
  return false;
}

/** A station's daytime routes include the line (dataset uses "S" for shuttles and "SIR"). */
export function stationServesLine(station: StationInfo, line: string): boolean {
  const l = line.trim().toUpperCase().replace(/X$/, '');
  const normalized = l === 'SI' ? 'SIR' : ['GS', 'FS', 'H'].includes(l) ? 'S' : l;
  return station.routes.includes(normalized);
}

/** Platform direction label for a stop ID ending in N or S, e.g. "635N" → "Uptown". */
export function directionLabel(stopId: string): string | null {
  const suffix = stopId.slice(-1);
  if (suffix !== 'N' && suffix !== 'S') return null;
  const info = getStationInfo(stopId);
  if (!info) return suffix === 'N' ? 'Northbound' : 'Southbound';
  return suffix === 'N' ? info.northLabel : info.southLabel;
}

/**
 * Does a platform match what the rider asked for? Checks the MTA label
 * ("uptown" ⊂ "Uptown & The Bronx", "queens", "coney island") and north/south as a fallback.
 */
export function directionMatches(stopId: string, requested: string): boolean {
  const q = requested.trim().toLowerCase();
  const suffix = stopId.slice(-1);
  if (['north', 'northbound', 'n'].includes(q)) return suffix === 'N';
  if (['south', 'southbound', 's'].includes(q)) return suffix === 'S';
  const label = directionLabel(stopId)?.toLowerCase() ?? '';
  return label.includes(q);
}
