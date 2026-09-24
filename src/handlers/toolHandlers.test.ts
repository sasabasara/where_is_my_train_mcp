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
      { tripUpdate: { trip: { routeId: 'A' } } }
    ],
    feedStatus: { successful: 7, failed: 1, failedFeeds: ['g'] }
  }))
}));

vi.mock('../services/stationService.js', () => ({
  ensureDataLoaded: vi.fn(async () => {}),
  getStopsData: () => [{ stop_id: 'S22', stop_name: 'New Dorp', location_type: '1', parent_station: '', stop_lat: '0', stop_lon: '0' }],
  getTransfersData: () => [],
  getGTFSSourceInfo: vi.fn(),
  StationMatcher: {}
}));

const {
  handleServiceDisruptions,
  handleSubwayAlerts,
  handleServiceStatus,
  handleElevatorEscalatorStatus
} = await import('./toolHandlers.js');

const payload = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(CAPTURED_AT_MS);
});

afterEach(() => {
  vi.useRealTimers();
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
    expect(data.disruptions[0].activeUntil).toBe(1790210700 * 1000);
  });

  it('resolves affected stop IDs to station names', async () => {
    const { data } = payload(await handleServiceDisruptions({ line: 'SI' }));
    expect(data.disruptions[0].affectedStations).toEqual(['New Dorp']);
    expect(data.systemStatus).toBe('service_changes');
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
    expect(data.alerts[0].activePeriod.start).toBe(1792813500 * 1000);
  });

  it('uses the plain-English text, not the HTML translation', async () => {
    const { data } = payload(await handleSubwayAlerts({ line: 'A' }));
    expect(data.alerts[0].header).not.toMatch(/<[a-z]/i);
  });
});

describe('service_status', () => {
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

  it('includes return estimate and the MTA alternative route', async () => {
    const { data } = payload(await handleElevatorEscalatorStatus({ station: 'queensbridge' }));
    expect(data.outages[0]).toMatchObject({ equipmentId: 'EL407', estimatedReturn: '09/24/2026 06:00:00 AM' });
    expect(data.outages[0].alternativeRoute).toEqual(expect.any(String));
  });
});
