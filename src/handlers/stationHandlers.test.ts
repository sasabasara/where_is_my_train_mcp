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
const tripTo = (routeId: string, tripId: string, stopId: string, minutes: number, terminal: string) => ({
  tripUpdate: {
    trip: { routeId, tripId },
    stopTimeUpdate: [
      { stopId, arrival: { time: inMinutes(minutes) } },
      { stopId: terminal, arrival: { time: inMinutes(minutes + 20) } }
    ]
  }
});
// Terminal is a stop outside every fixture complex, so each trip yields one arrival
const trip = (routeId: string, tripId: string, stopId: string, minutes: number) => tripTo(routeId, tripId, stopId, minutes, '999N');

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
      trip('A', 't8', 'A27N', 7),
      tripTo('4', 't9', '635N', 8, '401N'),   // uptown to Woodlawn (Bronx)
      tripTo('Q', 't10', 'R20S', 9, 'D43S'),  // downtown to Coney Island (Brooklyn), terminates there
      trip('D', 't11', 'D43N', 3),            // departs Coney Island
      { tripUpdate: { trip: { routeId: 'GS', tripId: 't12' }, stopTimeUpdate: [{ stopId: '902N', arrival: { time: inMinutes(2) } }] } } // shuttle ending at Times Sq
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
    getStopName: (id: string) => stops.find(s => s.stop_id === id.replace(/[NS]$/, ''))?.stop_name ?? id,
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
    expect(data.arrivals.map((a: any) => a.line)).toEqual(['6', '6X', '4']);
    expect(data.arrivals.every((a: any) => a.direction === 'Uptown')).toBe(true);
  });

  it('labels each arrival with its direction and platform stop ID', async () => {
    const { data } = payload(await handleNextTrains({ station: 'union sq' }));
    expect(data.arrivals.find((a: any) => a.line === 'L')).toMatchObject({ direction: 'West Side', stopId: 'L03N' });
    // Directions of trains actually coming (no Brooklyn-bound L in this snapshot)
    expect(data.availableDirections.sort()).toEqual(['Downtown', 'Uptown', 'West Side']);
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
    expect(data.note).toMatch(/No upcoming trains match "queens"/);
  });

  it('matches direction against the destination and its borough', async () => {
    const bronx = payload(await handleNextTrains({ station: 'union sq', direction: 'bronx' })).data;
    expect(bronx.arrivals).toMatchObject([{ line: '4', destination: 'Woodlawn', destinationBorough: 'Bronx' }]);

    const coney = payload(await handleNextTrains({ station: 'union sq', direction: 'coney island' })).data;
    expect(coney.arrivals.map((a: any) => a.line)).toEqual(['Q']);

    const brooklyn = payload(await handleNextTrains({ station: 'union sq', direction: 'brooklyn' })).data;
    expect(brooklyn.arrivals.map((a: any) => a.line)).toEqual(['Q']);
  });

  it('leaves out trains that end their run at the station', async () => {
    const coney = payload(await handleNextTrains({ stop_id: 'D43' })).data;
    expect(coney.arrivals.map((a: any) => a.tripId)).toEqual(['t11']);

    const timesSq = payload(await handleNextTrains({ station: 'times sq-42 st', line: 'S' })).data;
    expect(timesSq.arrivals).toEqual([]);
  });

  it('explains an empty result, including a line that does not stop there', async () => {
    const b = payload(await handleNextTrains({ station: 'union sq', line: 'B' })).data;
    expect(b.note).toMatch(/The B isn't a daytime line at 14 St-Union Sq .*night and weekend service can differ/);

    const n = payload(await handleNextTrains({ station: 'times sq-42 st', line: 'N' })).data;
    expect(n.note).toMatch(/No upcoming N trains/);
    expect(n.note).not.toMatch(/isn't a daytime line/);
  });

  it('clamps limit to 1-10', async () => {
    expect(payload(await handleNextTrains({ station: 'union sq', limit: -3 })).data.count).toBe(1);
    expect(payload(await handleNextTrains({ station: 'union sq', limit: 500 })).data.count).toBeLessThanOrEqual(10);
  });

  it('offers every major hub on a numbered street ("42nd st" includes Grand Central)', async () => {
    const { data } = payload(await handleNextTrains({ station: '42nd st' }));
    expect(data.ambiguous).toBe(true);
    const lines = data.options.map((o: any) => o.lines.join(''));
    // Grand Central, Bryant Pk, Times Sq complex
    expect(lines.sort()).toEqual(['1237ACENQRSW', '4567S', '7BDFM']);
  });

  it('understands ordinals and offers the major hubs ("34th street")', async () => {
    const { data } = payload(await handleNextTrains({ station: '34th street' }));
    expect(data.ambiguous).toBe(true);
    expect(data.options.map((o: any) => o.name).sort()).toEqual(['34 St-Herald Sq', '34 St-Penn Station', '34 St-Penn Station']);
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
  it('asks which station for an ambiguous name', async () => {
    const { data } = payload(await handleStationTransfers({ station: '23 st' }));
    expect(data.ambiguous).toBe(true);
    expect(data.options).toHaveLength(4);
  });

  it('lists every line reachable in the complex', async () => {
    const { data } = payload(await handleStationTransfers({ station: 'times sq' }));
    expect(data.lines).toEqual(['1', '2', '3', '7', 'A', 'C', 'E', 'N', 'Q', 'R', 'S', 'W']);
    expect(data.connections.map((c: any) => c.stopId).sort()).toEqual(['127', '725', '902', 'A27', 'R16']);
  });
});
