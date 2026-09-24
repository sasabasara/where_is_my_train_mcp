import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseCSV } from '../utils/csvParser.js';

// Real rows from the MTA Subway Stations dataset and GTFS stops.txt (captured 2026-09-24)
const fixtureDir = path.join(__dirname, '../__fixtures__');
const stationRows = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'stations.json'), 'utf-8'));
const stops = parseCSV(fs.readFileSync(path.join(fixtureDir, 'stops.txt'), 'utf-8'));

const NOW = Date.UTC(2026, 8, 24, 1, 0, 0);
const inMinutes = (m: number) => String(Math.floor((NOW + m * 60_000) / 1000));
// Terminal is a stop outside every fixture complex, so each trip yields one arrival
const trip = (routeId: string, tripId: string, stopId: string, minutes: number) => ({
  tripUpdate: {
    trip: { routeId, tripId },
    stopTimeUpdate: [
      { stopId, arrival: { time: inMinutes(minutes) } },
      { stopId: '999N', arrival: { time: inMinutes(minutes + 20) } }
    ]
  }
});

vi.mock('../services/mtaService.js', () => ({
  fetchMTAData: vi.fn(async () => ({
    entity: [
      trip('6', 't1', '635N', 2),
      trip('6X', 't2', '635N', 4),
      trip('4', 't3', '635S', 3),
      trip('L', 't4', 'L03N', 5),
      trip('1', 't5', '130S', 1),
      trip('F', 't6', 'D18N', 2),
      trip('7', 't7', '725N', 6),
      trip('A', 't8', 'A27N', 7)
    ],
    feedStatus: { successful: 8, failed: 0, failedFeeds: [] }
  })),
  fetchMTAAlerts: vi.fn(),
  fetchEquipmentOutages: vi.fn(),
  fetchEquipmentList: vi.fn()
}));

vi.mock('../services/stationService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/stationService.js')>();
  return {
    ...actual,
    ensureDataLoaded: vi.fn(async () => {}),
    getStopsData: () => stops,
    getTransfersData: () => []
  };
});

vi.mock('../services/stationInfoService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/stationInfoService.js')>();
  return { ...actual, ensureStationInfoLoaded: vi.fn(async () => {}) };
});

const { setStations } = await import('../services/stationInfoService.js');
const { handleNextTrains, handleFindStation, handleNearestStation, handleStationTransfers } = await import('./toolHandlers.js');

const payload = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text);

beforeAll(() => {
  setStations(stationRows);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe('next_trains', () => {
  it('filters by direction using the MTA platform label', async () => {
    const { data } = payload(await handleNextTrains({ station: 'union sq', direction: 'uptown' }));
    expect(data.arrivals.map((a: any) => a.line)).toEqual(['6', '6X']);
    expect(data.arrivals.every((a: any) => a.direction === 'Uptown')).toBe(true);
  });

  it('labels each arrival with its direction and platform stop ID', async () => {
    const { data } = payload(await handleNextTrains({ station: 'union sq' }));
    expect(data.arrivals.find((a: any) => a.line === 'L')).toMatchObject({ direction: 'West Side', stopId: 'L03N' });
    expect(data.availableDirections).toEqual(expect.arrayContaining(['Uptown', 'Downtown', 'West Side', 'Brooklyn']));
  });

  it('line "6" includes the 6X express', async () => {
    const { data } = payload(await handleNextTrains({ station: 'union sq', line: '6' }));
    expect(data.arrivals.map((a: any) => a.line)).toEqual(['6', '6X']);
  });

  it('asks which station when a name matches several separate stations', async () => {
    const { data } = payload(await handleNextTrains({ station: '23 st' }));
    expect(data.ambiguous).toBe(true);
    expect(data.arrivals).toEqual([]);
    expect(data.options.map((o: any) => o.lines.join(''))).toEqual(expect.arrayContaining(['RW', 'CE', 'FM', '1']));
  });

  it('a line resolves the ambiguity', async () => {
    const { data } = payload(await handleNextTrains({ station: '23 st', line: 'F' }));
    expect(data.ambiguous).toBeUndefined();
    expect(data.arrivals).toMatchObject([{ line: 'F', stopId: 'D18N' }]);
  });

  it('a stop_id resolves the ambiguity', async () => {
    const { data } = payload(await handleNextTrains({ stop_id: '130' }));
    expect(data.arrivals).toMatchObject([{ line: '1', direction: 'Downtown' }]);
  });

  it('treats a whole complex as one station (Times Sq includes the 7 and Port Authority A/C/E)', async () => {
    const { data } = payload(await handleNextTrains({ station: 'times sq-42 st' }));
    expect(data.ambiguous).toBeUndefined();
    expect(data.arrivals.map((a: any) => a.line).sort()).toEqual(['7', 'A']);
  });

  it('shows all directions with a note when the direction does not apply', async () => {
    const { data } = payload(await handleNextTrains({ stop_id: '130', direction: 'queens' }));
    expect(data.arrivals).toHaveLength(1);
    expect(data.directionNote).toMatch(/doesn't match/);
  });
});

describe('find_station', () => {
  it('returns one entry per complex with lines and accessibility', async () => {
    const { data } = payload(await handleFindStation({ query: '23 st' }));
    const plain = data.stations.filter((s: any) => s.name === '23 St');
    expect(plain).toHaveLength(4);
    expect(plain.every((s: any) => s.accessibility === 'none')).toBe(true);
  });

  it('reports partial accessibility for a complex with some accessible platforms', async () => {
    const { data } = payload(await handleFindStation({ query: 'union sq' }));
    expect(data.stations[0]).toMatchObject({ name: '14 St-Union Sq', lines: ['4', '5', '6', 'L', 'N', 'Q', 'R', 'W'], accessibility: 'partial' });
    expect(data.stations[0].accessibilityNotes).toBe('Accessible: N Q R W, L. Not accessible: 4 5 6');
  });
});

describe('nearest_station', () => {
  const unionSq = { lat: 40.7359, lon: -73.9906 };

  it('lists each complex once with its lines', async () => {
    const { data } = payload(await handleNearestStation({ ...unionSq, radius: 600 }));
    expect(data.filter((s: any) => s.name === '14 St-Union Sq')).toHaveLength(1);
    expect(data[0].lines).toContain('L');
  });

  it('service_filter keeps only stations serving the line', async () => {
    const { data } = payload(await handleNearestStation({ ...unionSq, radius: 2000, service_filter: ['F'] }));
    expect(data.map((s: any) => s.name)).toEqual(['23 St', '34 St-Herald Sq']);
  });

  it('accessible_only drops inaccessible stations', async () => {
    const { data } = payload(await handleNearestStation({ ...unionSq, radius: 2000, accessible_only: true }));
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((s: any) => s.accessibility !== 'none')).toBe(true);
    expect(data.map((s: any) => s.name)).not.toContain('23 St');
  });
});

describe('station_transfers', () => {
  it('lists every line reachable in the complex', async () => {
    const { data } = payload(await handleStationTransfers({ station: 'times sq' }));
    expect(data.lines).toEqual(['1', '2', '3', '7', 'A', 'C', 'E', 'N', 'Q', 'R', 'S', 'W']);
    expect(data.connections.map((c: any) => c.stopId).sort()).toEqual(['127', '725', '902', 'A27', 'R16']);
  });
});
