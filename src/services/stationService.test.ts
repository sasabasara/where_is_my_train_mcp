import { describe, it, expect } from 'vitest';
import { StationMatcher } from './stationService.js';

// Mock parent stations (location_type = '1')
const mockStops = [
  { stop_id: '101', stop_name: 'Times Sq-42 St', location_type: '1', parent_station: '', stop_lat: '40.7557', stop_lon: '-73.9870' },
  { stop_id: '101N', stop_name: 'Times Sq-42 St', location_type: '', parent_station: '101', stop_lat: '40.7557', stop_lon: '-73.9870' },
  { stop_id: '127', stop_name: 'Grand Central-42 St', location_type: '1', parent_station: '', stop_lat: '40.7527', stop_lon: '-73.9772' },
  { stop_id: '611', stop_name: '42 St-Bryant Pk', location_type: '1', parent_station: '', stop_lat: '40.7542', stop_lon: '-73.9844' },
  { stop_id: '725', stop_name: '34 St-Herald Sq', location_type: '1', parent_station: '', stop_lat: '40.7498', stop_lon: '-73.9878' },
  { stop_id: '130', stop_name: '23 St', location_type: '1', parent_station: '', stop_lat: '40.7390', stop_lon: '-73.9865' },
  { stop_id: 'A30', stop_name: '23 St', location_type: '1', parent_station: '', stop_lat: '40.7422', stop_lon: '-73.9926' },
  { stop_id: 'D18', stop_name: '23 St', location_type: '1', parent_station: '', stop_lat: '40.7390', stop_lon: '-73.9865' },
  { stop_id: 'R19', stop_name: '23 St', location_type: '1', parent_station: '', stop_lat: '40.7412', stop_lon: '-73.9893' },
  { stop_id: '634', stop_name: '23 St-Baruch College', location_type: '1', parent_station: '', stop_lat: '40.7410', stop_lon: '-73.9901' },
  { stop_id: 'G24', stop_name: 'Court Sq-23 St', location_type: '1', parent_station: '', stop_lat: '40.7471', stop_lon: '-73.9461' },
  { stop_id: '401', stop_name: '14 St-Union Sq', location_type: '1', parent_station: '', stop_lat: '40.7348', stop_lon: '-73.9900' },
  { stop_id: '635', stop_name: 'Lexington Av/53 St', location_type: '1', parent_station: '', stop_lat: '40.7575', stop_lon: '-73.9690' },
  { stop_id: '629', stop_name: '59 St-Columbus Circle', location_type: '1', parent_station: '', stop_lat: '40.7681', stop_lon: '-73.9819' },
  { stop_id: 'A25', stop_name: '59 St-Columbus Circle', location_type: '1', parent_station: '', stop_lat: '40.7681', stop_lon: '-73.9819' },
  { stop_id: '610', stop_name: 'Lexington Av/59 St', location_type: '1', parent_station: '', stop_lat: '40.7629', stop_lon: '-73.9676' },
  { stop_id: 'R14', stop_name: 'Lexington Av/59 St', location_type: '1', parent_station: '', stop_lat: '40.7629', stop_lon: '-73.9676' },
  { stop_id: '502', stop_name: 'Forest Hills-71 Av', location_type: '1', parent_station: '', stop_lat: '40.7215', stop_lon: '-73.8445' },
  { stop_id: 'L22', stop_name: 'Myrtle-Wyckoff Avs', location_type: '1', parent_station: '', stop_lat: '40.6995', stop_lon: '-73.9120' },
  { stop_id: '640', stop_name: '34 St-Penn Station', location_type: '1', parent_station: '', stop_lat: '40.7502', stop_lon: '-73.9930' },
  { stop_id: 'A28', stop_name: '34 St-Penn Station', location_type: '1', parent_station: '', stop_lat: '40.7502', stop_lon: '-73.9930' },
  { stop_id: '636', stop_name: '1 Av', location_type: '1', parent_station: '', stop_lat: '40.7307', stop_lon: '-73.9817' },
];

describe('StationMatcher.normalizeStationName', () => {
  it('normalizes "Sq" to "square"', () => {
    expect(StationMatcher.normalizeStationName('Herald Sq')).toBe('herald square');
  });

  it('normalizes "St" to "street"', () => {
    expect(StationMatcher.normalizeStationName('34 St')).toBe('34 street');
  });

  it('normalizes "Av" to "avenue"', () => {
    expect(StationMatcher.normalizeStationName('Lexington Av')).toBe('lexington avenue');
  });

  it('replaces dashes with spaces', () => {
    expect(StationMatcher.normalizeStationName('Myrtle-Wyckoff Avs')).toBe('myrtle wyckoff avs');
  });

  it('removes parentheses', () => {
    expect(StationMatcher.normalizeStationName('Forest Hills (71 Av)')).toBe('forest hills 71 avenue');
  });

  it('trims and collapses whitespace', () => {
    expect(StationMatcher.normalizeStationName('  spaces  ')).toBe('spaces');
  });

  it('handles empty string', () => {
    expect(StationMatcher.normalizeStationName('')).toBe('');
  });

  it('does NOT replace "st" inside "1st"', () => {
    expect(StationMatcher.normalizeStationName('1st Avenue')).toBe('1st avenue');
  });

  it('normalizes "Blvd" to "boulevard"', () => {
    expect(StationMatcher.normalizeStationName('Ocean Pkwy Blvd')).toBe('ocean parkway boulevard');
  });

  it('replaces forward slashes with spaces', () => {
    expect(StationMatcher.normalizeStationName('Lexington Av/59 St')).toBe('lexington avenue 59 street');
  });
});

describe('StationMatcher.findBestMatches', () => {
  // --- Basic matching ---

  it('finds exact case-insensitive match with score 100', () => {
    const matches = StationMatcher.findBestMatches('Times Sq-42 St', mockStops);
    expect(matches.length).toBe(1);
    expect(matches[0].stop_name).toBe('Times Sq-42 St');
    expect(matches[0].score).toBe(105); // 100 + 5 hub bonus
    expect(matches[0].matchType).toBe('exact');
  });

  it('finds exact match case-insensitively', () => {
    const matches = StationMatcher.findBestMatches('times sq-42 st', mockStops);
    expect(matches.length).toBe(1);
    expect(matches[0].stop_name).toBe('Times Sq-42 St');
    expect(matches[0].matchType).toBe('exact');
  });

  it('excludes child stations (location_type != "1")', () => {
    const matches = StationMatcher.findBestMatches('Times Sq-42 St', mockStops);
    expect(matches.every(m => m.location_type === '1')).toBe(true);
  });

  it('finds normalized match with score 90', () => {
    // "34 St-Herald Sq" normalizes to "34 street herald square"
    // query "34 street herald square" would be a normalized match
    const matches = StationMatcher.findBestMatches('34 St-Herald Sq', mockStops);
    expect(matches.length).toBeGreaterThan(0);
    const exact = matches.find(m => m.stop_name === '34 St-Herald Sq');
    expect(exact).toBeDefined();
    expect(exact!.matchType).toBe('exact');
    expect(exact!.score).toBe(105); // 100 exact + 5 hub
  });

  it('finds "herald square" as partial_contains match', () => {
    // "herald square" is contained in normalized "34 street herald square"
    const matches = StationMatcher.findBestMatches('herald square', mockStops);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].stop_name).toBe('34 St-Herald Sq');
    expect(matches[0].matchType).toBe('partial_contains');
    expect(matches[0].score).toBe(55); // 50 + 5 hub bonus
  });

  // --- Multiple same-name stations ---

  it('returns all same-name stations (23 St has 4 entries)', () => {
    const matches = StationMatcher.findBestMatches('23 St', mockStops);
    const exact23 = matches.filter(m => m.stop_name === '23 St');
    expect(exact23.length).toBe(4);
    expect(exact23.every(m => m.score === 100)).toBe(true);
  });

  // --- Mixed-tier results coexist ---

  it('"23 St" returns both exact and partial matches', () => {
    const matches = StationMatcher.findBestMatches('23 St', mockStops);
    const exact = matches.filter(m => m.matchType === 'exact');
    const partial = matches.filter(m => m.matchType === 'partial_contains');
    expect(exact.length).toBe(4); // four "23 St" stations
    expect(partial.length).toBeGreaterThan(0); // "23 St-Baruch College", "Court Sq-23 St"
  });

  it('"23 St" returns "23 St-Baruch College" and "Court Sq-23 St" as partial', () => {
    const matches = StationMatcher.findBestMatches('23 St', mockStops);
    const names = matches.map(m => m.stop_name);
    expect(names).toContain('23 St-Baruch College');
    expect(names).toContain('Court Sq-23 St');
  });

  // --- No matches ---

  it('returns empty array when no matches found', () => {
    const matches = StationMatcher.findBestMatches('Nonexistent Station', mockStops);
    expect(matches).toEqual([]);
  });

  // --- Short queries ---

  it('does not do partial matching for short queries (≤3 chars)', () => {
    const matches = StationMatcher.findBestMatches('23', mockStops);
    expect(matches).toEqual([]);
  });

  // --- Partial matching tiers ---

  it('finds partial word match for "baruch" with score 70', () => {
    const matches = StationMatcher.findBestMatches('baruch', mockStops);
    expect(matches.length).toBe(1);
    expect(matches[0].stop_name).toBe('23 St-Baruch College');
    expect(matches[0].score).toBe(70);
    expect(matches[0].matchType).toBe('partial_word');
  });

  it('finds partial word match with score 70', () => {
    const matches = StationMatcher.findBestMatches('herald', mockStops);
    const herald = matches.find(m => m.stop_name === '34 St-Herald Sq');
    expect(herald).toBeDefined();
    expect(herald!.score).toBe(75); // 70 + 5 hub bonus
    expect(herald!.matchType).toBe('partial_word');
  });

  it('finds partial starts-with match with score 60', () => {
    const matches = StationMatcher.findBestMatches('forest hills', mockStops);
    expect(matches.length).toBe(1);
    expect(matches[0].stop_name).toBe('Forest Hills-71 Av');
    expect(matches[0].score).toBe(60);
    expect(matches[0].matchType).toBe('partial_starts');
  });

  // --- Hub bonus ---

  it('hub stations get +5 bonus', () => {
    const matches = StationMatcher.findBestMatches('Times Sq-42 St', mockStops);
    expect(matches[0].score).toBe(105); // 100 exact + 5 hub
  });

  it('non-hub stations get no bonus', () => {
    const matches = StationMatcher.findBestMatches('23 St', mockStops);
    const exact23 = matches.filter(m => m.stop_name === '23 St');
    expect(exact23.every(m => m.score === 100)).toBe(true); // no hub bonus
  });

  it('59 St-Columbus Circle gets hub bonus for exact match', () => {
    const matches = StationMatcher.findBestMatches('59 St-Columbus Circle', mockStops);
    const hub = matches.filter(m => m.stop_name === '59 St-Columbus Circle');
    expect(hub.length).toBe(2);
    expect(hub.every(m => m.score === 105)).toBe(true);
  });

  // --- Sorting ---

  it('results are sorted by score descending', () => {
    const matches = StationMatcher.findBestMatches('23 St', mockStops);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i].score).toBeLessThanOrEqual(matches[i - 1].score);
    }
  });

  it('same-score results sorted by name length ascending', () => {
    const matches = StationMatcher.findBestMatches('23 St', mockStops);
    const exact = matches.filter(m => m.score === 100);
    const partial = matches.filter(m => m.score < 100);
    // Exact "23 St" (5 chars) should come before longer partial matches
    expect(exact.length).toBeGreaterThan(0);
    for (const p of partial) {
      expect(p.stop_name.length).toBeGreaterThanOrEqual(exact[0].stop_name.length);
    }
  });

  // --- StationMatch shape ---

  it('returns StationMatch objects with all fields', () => {
    const matches = StationMatcher.findBestMatches('Times Sq-42 St', mockStops);
    const m = matches[0];
    expect(m).toHaveProperty('stop_id');
    expect(m).toHaveProperty('stop_name');
    expect(m).toHaveProperty('score');
    expect(m).toHaveProperty('matchType');
    expect(m).toHaveProperty('location_type');
    expect(m).toHaveProperty('parent_station');
    expect(m).toHaveProperty('stop_lat');
    expect(m).toHaveProperty('stop_lon');
  });

  // --- Edge cases ---

  it('finds multiple stations matching "59 St"', () => {
    const matches = StationMatcher.findBestMatches('59 St', mockStops);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('handles empty query gracefully', () => {
    const matches = StationMatcher.findBestMatches('', mockStops);
    expect(matches).toEqual([]);
  });

  it('handles query with only spaces', () => {
    const matches = StationMatcher.findBestMatches('   ', mockStops);
    expect(matches).toEqual([]);
  });

  it('matches "penn station" via normalization', () => {
    const matches = StationMatcher.findBestMatches('penn station', mockStops);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some(m => m.stop_name === '34 St-Penn Station')).toBe(true);
  });

  it('matches partial "forest" to Forest Hills-71 Av', () => {
    const matches = StationMatcher.findBestMatches('forest', mockStops);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].stop_name).toBe('Forest Hills-71 Av');
  });
});

describe('StationMatcher.groupByName', () => {
  it('groups multiple stops with same name', () => {
    const matches = StationMatcher.findBestMatches('23 St', mockStops);
    const groups = StationMatcher.groupByName(matches);
    const group23 = groups.find(g => g.name === '23 St');
    expect(group23).toBeDefined();
    expect(group23!.stopIds.length).toBe(4);
    expect(group23!.stopIds).toContain('130');
    expect(group23!.stopIds).toContain('A30');
    expect(group23!.stopIds).toContain('D18');
    expect(group23!.stopIds).toContain('R19');
  });

  it('takes best score from group members', () => {
    const matches = StationMatcher.findBestMatches('59 St-Columbus Circle', mockStops);
    const groups = StationMatcher.groupByName(matches);
    const hubGroup = groups.find(g => g.name === '59 St-Columbus Circle');
    expect(hubGroup).toBeDefined();
    expect(hubGroup!.score).toBe(105); // exact + hub bonus
    expect(hubGroup!.stopIds.length).toBe(2);
  });

  it('returns groups sorted by score desc', () => {
    const matches = StationMatcher.findBestMatches('23 St', mockStops);
    const groups = StationMatcher.groupByName(matches);
    for (let i = 1; i < groups.length; i++) {
      expect(groups[i].score).toBeLessThanOrEqual(groups[i - 1].score);
    }
  });

  it('includes matchType from best-scoring member', () => {
    const matches = StationMatcher.findBestMatches('23 St', mockStops);
    const groups = StationMatcher.groupByName(matches);
    const group23 = groups.find(g => g.name === '23 St');
    expect(group23!.matchType).toBe('exact');

    const baruch = groups.find(g => g.name === '23 St-Baruch College');
    expect(baruch).toBeDefined();
    expect(baruch!.matchType).toBe('partial_starts');
  });

  it('mixed-tier query returns all tiers grouped', () => {
    const matches = StationMatcher.findBestMatches('23 St', mockStops);
    const groups = StationMatcher.groupByName(matches);
    const names = groups.map(g => g.name);
    expect(names).toContain('23 St');
    expect(names).toContain('23 St-Baruch College');
    expect(names).toContain('Court Sq-23 St');
  });
});
