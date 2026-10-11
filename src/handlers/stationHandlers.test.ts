import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseCSV } from '../utils/csvParser.js';

// Real rows from the MTA Subway Stations dataset and GTFS stops.txt (captured 2026-09-24;
// 726, B10, R14, H04, H12 added 2026-10-11)
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
      { ...trip('6', 't1', '635N', 2), tripUpdate: { ...trip('6', 't1', '635N', 2).tripUpdate, trip: { routeId: '6', tripId: 't1', '.nyctTripDescriptor': { isAssigned: true } } } },
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
      tripTo('7', 't13', '726N', 4, '701N'),  // departs Hudson Yards, the dataset's "Last Stop" platform
      // Rockaway Park shuttle as the feed sends it: ends at relay track H19N, past Broad Channel
      { tripUpdate: { trip: { routeId: 'H', tripId: 't14' }, stopTimeUpdate: [
        { stopId: 'H12N', arrival: { time: inMinutes(3) } },
        { stopId: 'H04N', arrival: { time: inMinutes(9) } },
        { stopId: 'H19N', arrival: { time: inMinutes(12) } }
      ] } },
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
    getTransfersData: () => [],
    // Static GTFS has every stop except the relay track H19 the Rockaway Park shuttle ends at
    isKnownStop: (id: string) => !id.startsWith('H19')
  };
});

vi.mock('../services/stationInfoService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/stationInfoService.js')>();
  return { ...actual, ensureStationInfoLoaded: vi.fn(async () => {}) };
});

const { setStations } = await import('../services/stationInfoService.js');
const { fetchMTAData } = await import('../services/mtaService.js');
const { handleNextTrains, handleFindStation, handleNearestStation, handleStationTransfers } = await import('./toolHandlers.js');

const payload = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text);

afterEach(() => { setStations(stationRows); });

describe('audit regressions', () => {
  it('resolves the transfer follow-up using the stop_id offered in the ambiguity response', async () => {
    const choice = payload(await handleStationTransfers({ station: '23 st' })).data.options[0];
    const result = payload(await handleStationTransfers({ stop_id: choice.stopIds[0] } as any));
    expect(result.status).toBe('success');
    expect(result.data.ambiguous).toBeUndefined();
    expect(result.data.connections.map((c: any) => c.stopId)).toContain(choice.stopIds[0]);
  });

  it('requires accessibility on the requested line, not another line in the complex', async () => {
    const result = payload(await handleNearestStation({ lat: 40.7359, lon: -73.9906, radius: 600, accessible_only: true, service_filter: ['6'] }));
    expect(result.data.map((s: any) => s.name)).not.toContain('14 St-Union Sq');
    expect(result.data.map((s: any) => s.name)).toContain('23 St-Baruch College');
  });

  it('keeps same-name stations separate when the station metadata feed is unavailable', async () => {
    setStations([]);
    const result = payload(await handleNextTrains({ station: '23 st' }));
    expect(result.data.ambiguous).toBe(true);
    expect(result.data.options.filter((s: any) => s.name === '23 St')).toHaveLength(4);
  });

  it('does not return southbound trains for an explicit N request with no northbound service', async () => {
    const result = payload(await handleNextTrains({ stop_id: '130', direction: 'N' }));
    expect(result.data.arrivals).toEqual([]);
    expect(result.data.note).toMatch(/No upcoming trains match/);
  });

  it('excludes canceled trips and skipped stops even when the feed supplies arrival times', async () => {
    const canceled = trip('6', 'canceled', '635N', 1) as any;
    canceled.tripUpdate.trip.scheduleRelationship = 'CANCELED';
    const skipped = trip('6', 'skipped', '635N', 2) as any;
    skipped.tripUpdate.stopTimeUpdate[0].scheduleRelationship = 'SKIPPED';
    vi.mocked(fetchMTAData).mockResolvedValueOnce({ entity: [canceled, skipped, trip('6', 'running', '635N', 3)] } as any);
    const result = payload(await handleNextTrains({ stop_id: '635N' }));
    expect(result.data.arrivals.map((a: any) => a.tripId)).toEqual(['running']);
  });

  it('identifies arrivals served from a stale feed', async () => {
    vi.mocked(fetchMTAData).mockResolvedValueOnce({ entity: [trip('6', 'cached', '635N', 3)], feedStatus: { failedFeeds: [], staleFeeds: ['1234567s'] } } as any);
    const result = payload(await handleNextTrains({ stop_id: '635N' }));
    expect(result.data.staleFeeds).toEqual(['1234567s']);
    expect(result.data.note).toMatch(/cached/i);
  });

  it('rejects impossible coordinates instead of computing a plausible nearby station', async () => {
    const result = await handleNearestStation({ lat: 400, lon: -74 });
    expect(result.isError).toBe(true);
  });
});

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

  it('marks arrivals from dispatched trains as confirmed', async () => {
    const { data } = payload(await handleNextTrains({ station: 'union sq', line: '6' }));
    expect(data.arrivals.map((a: any) => [a.tripId, a.confirmed])).toEqual([['t1', true], ['t2', false]]);
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
    expect(data.options.map((o: any) => o.name).sort()).toEqual(['34 St-Herald Sq', '34 St-Hudson Yards', '34 St-Penn Station', '34 St-Penn Station']);
  });

  it('offers stations named the query plus a qualifier ("57 st" includes 57 St-7 Av)', async () => {
    const plain = payload(await handleNextTrains({ station: '57 st' })).data;
    expect(plain.options.map((o: any) => o.name).sort()).toEqual(['57 St', '57 St-7 Av']);

    const baruch = payload(await handleNextTrains({ station: '23 st' })).data;
    expect(baruch.options.map((o: any) => o.name)).toContain('23 St-Baruch College');
  });

  it('a line picks the station it serves, even when another name fits better', async () => {
    const n = payload(await handleNextTrains({ station: '57 st', line: 'N' })).data;
    expect(n).toMatchObject({ station: '57 St-7 Av', stopIds: ['R14'] });
    expect(n.note ?? '').not.toMatch(/isn't a daytime line/);

    const six = payload(await handleNextTrains({ station: '23rd street', line: '6' })).data;
    expect(six).toMatchObject({ station: '23 St-Baruch College', stopIds: ['634'] });
  });

  it('"N" and "s" pick the platform direction, not destinations containing the letter', async () => {
    const north = payload(await handleNextTrains({ station: 'union sq', direction: 'N' })).data;
    expect(north.arrivals.map((a: any) => a.tripId).sort()).toEqual(['t1', 't2', 't4', 't9']);

    const south = payload(await handleNextTrains({ station: 'union sq', direction: 's' })).data;
    expect(south.arrivals.map((a: any) => a.tripId).sort()).toEqual(['t10', 't3']);
  });

  it('understands "-bound" and "to the ..." directions', async () => {
    const bronx = payload(await handleNextTrains({ station: 'union sq', direction: 'to the Bronx' })).data;
    expect(bronx.arrivals.map((a: any) => a.tripId)).toEqual(['t9']);

    const coney = payload(await handleNextTrains({ station: 'union sq', direction: 'Coney Island-bound' })).data;
    expect(coney.arrivals.map((a: any) => a.tripId)).toEqual(['t10']);
  });

  it('a platform stop_id ("635N") returns only that platform', async () => {
    const { data } = payload(await handleNextTrains({ stop_id: '635n' }));
    expect(data.arrivals.map((a: any) => a.stopId)).toEqual(['635N', '635N', '635N']);
    expect(data.arrivals.map((a: any) => a.line)).toEqual(['6', '6X', '4']);
  });

  it('names the last real station as the destination when the feed ends a trip on a relay track', async () => {
    const beach90 = payload(await handleNextTrains({ station: 'beach 90 st' })).data;
    expect(beach90.arrivals).toMatchObject([{ line: 'H', destination: 'Broad Channel' }]);

    // ...and the shuttle ends its run at Broad Channel, so it isn't a train to board there
    const broadChannel = payload(await handleNextTrains({ station: 'broad channel' })).data;
    expect(broadChannel.arrivals).toEqual([]);
  });

  it('labels trains leaving a terminal with their direction, not "Last Stop"', async () => {
    const { data } = payload(await handleNextTrains({ station: 'hudson yards' }));
    expect(data.arrivals).toMatchObject([{ line: '7', stopId: '726N', direction: 'Queens' }]);
    expect(data.availableDirections).toEqual(['Queens']);
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

  it('says how far the closest station is when none is in range', async () => {
    const hudson = payload(await handleNearestStation({ lat: 40.73, lon: -74.03, radius: 500 }));
    expect(hudson.data).toEqual([]);
    expect(hudson.message).toMatch(/The closest is .+ \(stopId \w+\), \d+m away/);

    const offMap = payload(await handleNearestStation({ lat: 0, lon: 0 }));
    expect(offMap.message).toMatch(/km away — check the coordinates/);

    // The closest station that matches the filters (the 7 at 5 Av, in the Bryant Pk complex)
    const seven = payload(await handleNearestStation({ ...unionSq, radius: 300, service_filter: ['7'] }));
    expect(seven.message).toMatch(/The closest is 42 St-Bryant Pk \(stopId D16\)/);
  });

  it('treats a zero or negative radius as the 1000m default', async () => {
    const { message } = payload(await handleNearestStation({ ...unionSq, radius: -5 }));
    expect(message).toMatch(/within 1000m/);
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
    expect(data.options).toHaveLength(5);
    expect(data.options.map((o: any) => o.name)).toContain('23 St-Baruch College');
  });

  it('lists every line reachable in the complex', async () => {
    const { data } = payload(await handleStationTransfers({ station: 'times sq' }));
    expect(data.lines).toEqual(['1', '2', '3', '7', 'A', 'C', 'E', 'N', 'Q', 'R', 'S', 'W']);
    expect(data.connections.map((c: any) => c.stopId).sort()).toEqual(['127', '725', '902', 'A27', 'R16']);
  });
});
