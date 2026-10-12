import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Snapshots of the live MTA feeds captured 2026-09-24 00:36 UTC (8:36pm ET, Wednesday)
const fixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '../__fixtures__', name), 'utf-8'));
const alertsFeed = fixture('subway-alerts.json');
const CAPTURED_AT_MS = alertsFeed.header.timestamp * 1000;

vi.mock('../services/mtaService.js', () => ({
  fetchMTAAlerts: vi.fn(async () => alertsFeed),
  fetchEquipmentOutages: vi.fn(async () => fixture('ene-outages.json')),
  fetchEquipmentList: vi.fn(async () => fixture('ene-equipments.json')),
  fetchMTAData: vi.fn(async () => ({
    entity: [
      { tripUpdate: { trip: { routeId: 'L' } } },
      { tripUpdate: { trip: { routeId: 'L' } } },
      { tripUpdate: { trip: { routeId: 'A' } } },
      { tripUpdate: { trip: { routeId: 'GS' } } }
    ],
    feedStatus: { successful: 7, failed: 1, failedFeeds: ['g'] }
  }))
}));

vi.mock('../services/stationService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/stationService.js')>()),
  ensureDataLoaded: vi.fn(async () => {}),
  getStopsData: () => [{ stop_id: 'S22', stop_name: 'New Dorp', location_type: '1', parent_station: '', stop_lat: '0', stop_lon: '0' }],
  getTransfersData: () => [],
  getStopName: (id: string) => (id === 'S22' ? 'New Dorp' : id),
  // Real routes.txt rows (2026-10-11)
  getRoutesData: () => [
    { route_id: 'B', route_short_name: 'B', route_long_name: '6 Avenue Express', route_desc: 'Trains operate, weekdays only, between 145 St, Manhattan, and Brighton Beach, Brooklyn.' },
    { route_id: 'L', route_short_name: 'L', route_long_name: '14 St-Canarsie Local', route_desc: 'Trains operate between 8 Av, Manhattan, and Canarsie-Rockaway Pkwy, Brooklyn.' }
  ]
}));

const {
  handleServiceDisruptions,
  handleSubwayAlerts,
  handleServiceStatus,
  handleElevatorEscalatorStatus
} = await import('./toolHandlers.js');
const { fetchMTAData, fetchMTAAlerts } = await import('../services/mtaService.js');
const allFeedsUp = { feedStatus: { successful: 8, failed: 0, failedFeeds: [], staleFeeds: [] } };

const payload = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(CAPTURED_AT_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('every response', () => {
  it('says the data comes from MTA feeds and may not be real time (MTA terms)', async () => {
    for (const result of [await handleServiceStatus({}), await handleElevatorEscalatorStatus({})]) {
      expect(payload(result).metadata.source).toBe('MTA data feeds; may not be real time');
    }
  });
});

describe('service_disruptions', () => {
  it('reports disruption when active delays/suspensions exist', async () => {
    const { data } = payload(await handleServiceDisruptions({}));
    expect(data.systemStatus).toBe('disrupted');
    expect(data.counts).toMatchObject({ total: 3, critical: 1, major: 1, minor: 1, planned: 0 });
    expect(data.disruptions[0]).toMatchObject({ lines: ['2', '5'], severity: 'CRITICAL', alertType: 'Part Suspended' });
  });

  it('filters by line', async () => {
    const { data } = payload(await handleServiceDisruptions({ line: 'c' }));
    expect(data.disruptions).toHaveLength(1);
    expect(data.disruptions[0]).toMatchObject({ lines: ['A', 'C', 'F'], severity: 'MAJOR', category: 'DELAYS' });
    expect(data.disruptions[0].activeUntil).toBe('2026-09-23T20:45:00-04:00');
  });

  it('resolves affected stop IDs to station names', async () => {
    const { data } = payload(await handleServiceDisruptions({ line: 'SI' }));
    expect(data.disruptions[0].affectedStations).toEqual(['New Dorp']);
    expect(data.systemStatus).toBe('service_changes');
  });

  it('matches a location the way riders type station names', async () => {
    const jay = payload(await handleServiceDisruptions({ location: 'Jay Street-MetroTech' })).data;
    expect(jay.disruptions.map((d: any) => d.lines)).toEqual([['A', 'C', 'F']]);

    const flatbush = payload(await handleServiceDisruptions({ location: 'flatbush avenue' })).data;
    expect(flatbush.disruptions.map((d: any) => d.lines)).toEqual([['2', '5']]);

    // Word starts only: "rooklyn" is not "Brooklyn"
    expect(payload(await handleServiceDisruptions({ location: 'rooklyn' })).data.counts.total).toBe(0);
  });

  it('shortens long descriptions in the system-wide overview only', async () => {
    const overview = payload(await handleServiceDisruptions({}));
    const twoFive = overview.data.disruptions.find((d: any) => d.lines.includes('2'));
    expect(overview.data.descriptionsShortened).toBe(true);
    expect(twoFive.description.length).toBeLessThanOrEqual(301);
    expect(twoFive.description.endsWith('…')).toBe(true);
    expect(overview.message).toMatch(/descriptions shortened/);

    const line = payload(await handleServiceDisruptions({ line: '2' })).data;
    expect(line.descriptionsShortened).toBe(false);
    expect(line.disruptions[0].description.length).toBeGreaterThan(300);
  });

  it('says when a line has no trains running instead of "normal" (the B on a weekend)', async () => {
    vi.mocked(fetchMTAData).mockResolvedValueOnce({ entity: [{ tripUpdate: { trip: { routeId: 'L' } } }], ...allFeedsUp } as any);
    const { data, message } = payload(await handleServiceDisruptions({ line: 'b' }));
    expect(data).toMatchObject({ systemStatus: 'no_trains_reported', trainsRunning: 0 });
    expect(data.servicePattern).toMatch(/weekdays only/);
    expect(message).toMatch(/No B trains are currently reported by the MTA/);
  });

  it('names an express line as such, so "no 6X trains" is not "no 6 trains"', async () => {
    vi.mocked(fetchMTAData).mockResolvedValueOnce({ entity: [{ tripUpdate: { trip: { routeId: '6' } } }], ...allFeedsUp } as any);
    const { message } = payload(await handleServiceDisruptions({ line: '6X' }));
    expect(message).toMatch(/No 6 express trains are currently reported/);
  });

  it('does not claim "no trains" while a feed is down', async () => {
    // The default mock has the G feed down
    const { data } = payload(await handleServiceDisruptions({ line: 'G' }));
    expect(data).toMatchObject({ systemStatus: 'normal', trainsRunning: null });
  });

  it('reports trains running on a line with no alerts', async () => {
    vi.mocked(fetchMTAData).mockResolvedValueOnce({ entity: [{ tripUpdate: { trip: { routeId: 'L' } } }], ...allFeedsUp } as any);
    const { data } = payload(await handleServiceDisruptions({ line: 'L' }));
    expect(data).toMatchObject({ systemStatus: 'normal', trainsRunning: 1 });
    expect(data.servicePattern).toBeUndefined();
  });

  it('is normal when a line has no active alerts', async () => {
    const { data } = payload(await handleServiceDisruptions({ line: 'G' }));
    expect(data.systemStatus).toBe('normal');
  });
});

describe('subway_alerts', () => {
  it('returns only active alerts by default, most severe first, with severity set', async () => {
    const { data } = payload(await handleSubwayAlerts({}));
    expect(data.total).toBe(3);
    expect(data.alerts.map((a: any) => a.alertType)).toEqual(['Part Suspended', 'Delays', 'Station Notice']);
    expect(data.alerts.every((a: any) => a.severity && a.isActive)).toBe(true);
  });

  it('includes upcoming planned work when active_only is false', async () => {
    const { data } = payload(await handleSubwayAlerts({ active_only: false, category: 'PLANNED_WORK' }));
    expect(data.alerts).toHaveLength(1);
    expect(data.alerts[0]).toMatchObject({ alertType: 'Planned - Suspended', severity: 'PLANNED', isActive: false });
    expect(data.alerts[0].activePeriod.start).toBe('2026-10-23T23:45:00-04:00');
  });

  it('uses the plain-English text, not the HTML translation', async () => {
    const { data } = payload(await handleSubwayAlerts({ line: 'A' }));
    expect(data.alerts[0].header).not.toMatch(/<[a-z]/i);
  });
});

describe('line names riders use', () => {
  it('"S" counts the shuttles and "SIR" matches the SI route', async () => {
    expect(payload(await handleServiceStatus({ line: 'S' })).data.activeTrips).toBe(1);
    const sir = payload(await handleSubwayAlerts({ line: 'SIR' })).data;
    expect(sir.total).toBe(1);
    expect(sir.alerts[0].affectedLines).toEqual(['SIR']);
  });
});

describe('service_status', () => {
  it('points to subway_alerts when it shows only the top 3 alerts', async () => {
    const active = alertsFeed.entity.slice(0, 6).map((e: any, i: number) => ({ ...e, id: `copy:${i}` }));
    vi.mocked(fetchMTAAlerts).mockResolvedValueOnce({ ...alertsFeed, entity: [...alertsFeed.entity, ...active] });
    const { data, message } = payload(await handleServiceStatus({}));
    expect(data.activeAlerts).toBeGreaterThan(3);
    expect(data.topAlerts).toHaveLength(3);
    expect(data.note).toMatch(/^Showing the 3 most severe of \d+ alerts; subway_alerts lists them all\.$/);
    expect(message).toContain(data.note);
  });

  it('says when a line has no trains reported, with the MTA service pattern', async () => {
    vi.mocked(fetchMTAData).mockResolvedValueOnce({ entity: [], ...allFeedsUp } as any);
    const { data, message } = payload(await handleServiceStatus({ line: 'B' }));
    expect(data.servicePattern).toMatch(/weekdays only/);
    expect(data.note).toMatch(/No B trains are currently reported by the MTA/);
    expect(message).toMatch(/No B trains are currently reported by the MTA/);
  });

  it('has no note when there is nothing to add', async () => {
    const { data } = payload(await handleServiceStatus({ line: 'l' }));
    expect(data.note).toBeUndefined();
  });

  it('filters trips and alerts by line and surfaces failed feeds', async () => {
    const { data } = payload(await handleServiceStatus({ line: 'l' }));
    expect(data).toMatchObject({ line: 'L', activeTrips: 2, activeAlerts: 0, unavailableFeeds: ['g'] });
  });
});

describe('elevator_and_escalator_status', () => {
  it('defaults to current outages only', async () => {
    const { data } = payload(await handleElevatorEscalatorStatus({}));
    expect(data.total).toBe(3);
    expect(data.outages.every((o: any) => o.status === 'Currently Out')).toBe(true);
  });

  it('filters by equipment type and outage timing', async () => {
    const escalators = payload(await handleElevatorEscalatorStatus({ equipment_type: 'escalator' })).data;
    expect(escalators.outages.map((o: any) => o.equipmentId)).toEqual(['ES101']);

    const upcoming = payload(await handleElevatorEscalatorStatus({ outage_type: 'upcoming' })).data;
    expect(upcoming.outages.map((o: any) => o.status)).toEqual(['Upcoming Work', 'Upcoming Work']);
  });

  it('matches station names the way riders type them', async () => {
    const { data } = payload(await handleElevatorEscalatorStatus({ station: '34th st hudson yards' }));
    expect(data.outages.map((o: any) => o.station)).toEqual(['34 St-Hudson Yards']);
  });

  it('matches whole words only ("25th st" is not 125 St)', async () => {
    const { data, message } = payload(await handleElevatorEscalatorStatus({ station: '25th st', outage_type: 'all' }));
    expect(data.total).toBe(0);
    expect(data.equipmentListed).toEqual([]);
    expect(message).toMatch(/No elevators or escalators are listed at any station matching "25th st"/);
  });

  it('lists the equipment at matching stations, so 0 outages is not read as "no elevators"', async () => {
    const { data, message } = payload(await handleElevatorEscalatorStatus({ station: '125 st', equipment_type: 'elevator' }));
    expect(data.total).toBe(0); // its elevator outage is upcoming, not current
    expect(data.equipmentListed).toEqual([
      { station: '125 St', lines: '1', elevators: 0, escalators: 1 },
      { station: '125 St', lines: 'A/C/B/D', elevators: 2, escalators: 0 }
    ]);
    expect(message).toMatch(/Found 0 equipment outages at stations matching "125 st"/);
  });

  it('includes return estimate and the MTA alternative route', async () => {
    const { data } = payload(await handleElevatorEscalatorStatus({ station: 'queensbridge' }));
    expect(data.outages[0]).toMatchObject({ equipmentId: 'EL407', estimatedReturn: '2026-09-24T06:00:00-04:00' });
    expect(data.outages[0].alternativeRoute).toEqual(expect.any(String));
  });
});
