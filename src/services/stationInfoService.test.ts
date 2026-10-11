import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  setStations,
  normalizeDirection,
  compassDirection,
  getComplexRoutes,
  routeMatchesLine,
  stationServesLine,
  directionLabel,
  directionMatches,
  getStationInfo
} from './stationInfoService.js';

const rows = JSON.parse(fs.readFileSync(path.join(__dirname, '../__fixtures__/stations.json'), 'utf-8'));

beforeAll(() => {
  setStations(rows);
});

describe('setStations', () => {
  it('treats the dataset\'s "NaN" text as missing', () => {
    setStations(rows.map((r: any) => r.gtfs_stop_id === 'B10' ? { ...r, ada_notes: 'NaN', north_direction_label: 'NaN' } : r));
    expect(getStationInfo('B10')).toMatchObject({ accessibilityNotes: null, northLabel: 'Northbound', southLabel: 'Downtown' });
    setStations(rows);
  });
});

describe('routeMatchesLine', () => {
  it('matches express variants and shuttles', () => {
    expect(routeMatchesLine('6X', '6')).toBe(true);
    expect(routeMatchesLine('6', '6')).toBe(true);
    expect(routeMatchesLine('GS', 's')).toBe(true);
    expect(routeMatchesLine('SI', 'SIR')).toBe(true);
    expect(routeMatchesLine('5', '6')).toBe(false);
    expect(routeMatchesLine(undefined, '6')).toBe(false);
  });
});

describe('stationServesLine', () => {
  it('uses daytime routes, normalizing feed route IDs', () => {
    const timesSqShuttle = getStationInfo('902')!;
    expect(stationServesLine(timesSqShuttle, 'GS')).toBe(true);
    expect(stationServesLine(getStationInfo('635')!, '6X')).toBe(true);
    expect(stationServesLine(getStationInfo('635')!, 'L')).toBe(false);
  });
});

describe('directions', () => {
  it('uses the MTA platform labels', () => {
    expect(directionLabel('725N')).toBe('Queens');
    expect(directionLabel('725S')).toBe('Hudson Yards');
    expect(directionLabel('L03S')).toBe('Brooklyn');
    expect(directionLabel('725')).toBeNull();
  });

  it('gives terminals the direction trains leave in, never "Last Stop"', () => {
    // Coney Island: dataset says S = "Last Stop"; Hudson Yards has it on the departing N platform
    expect(directionLabel('D43N')).toBe('Manhattan');
    expect(directionLabel('D43S')).toBe('Manhattan');
    expect(directionLabel('726N')).toBe('Queens');
    expect(directionMatches('726N', 'queens')).toBe(true);
  });

  it('matches rider phrasing against labels, with north/south fallback', () => {
    expect(directionMatches('635N', 'uptown')).toBe(true);
    expect(directionMatches('635S', 'uptown')).toBe(false);
    expect(directionMatches('725N', 'Queens')).toBe(true);
    expect(directionMatches('725N', 'north')).toBe(true);
    expect(directionMatches('725N', 'uptown')).toBe(false);
  });

  it('understands "-bound", "to the ..." and single-letter compass directions', () => {
    expect(normalizeDirection('Manhattan-bound')).toBe('manhattan');
    expect(normalizeDirection('to the Bronx')).toBe('bronx');
    expect(normalizeDirection('Queens bound')).toBe('queens');
    expect(normalizeDirection('Inbound')).toBe('inbound');
    expect(compassDirection('N')).toBe('N');
    expect(compassDirection('southbound')).toBe('S');
    expect(compassDirection('uptown')).toBeNull();
    expect(directionMatches('725N', 'Queens-bound')).toBe(true);
    expect(directionMatches('725S', 'n')).toBe(false);
    expect(directionMatches('635N', 'bound')).toBe(false);
  });
});

describe('getComplexRoutes', () => {
  it('unions routes across a complex, numbers first', () => {
    expect(getComplexRoutes('R16')).toEqual(['1', '2', '3', '7', 'A', 'C', 'E', 'N', 'Q', 'R', 'S', 'W']);
  });
});
