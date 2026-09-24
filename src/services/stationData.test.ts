import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getGTFSData = vi.fn();
vi.mock('./gtfsManager.js', () => ({ GTFSManager: { getGTFSData } }));

const DAY = 24 * 60 * 60 * 1000;
const stops = [{ stop_id: '635', stop_name: '14 St-Union Sq', location_type: '1' }];

let svc: typeof import('./stationService.js');

beforeEach(async () => {
  vi.resetModules();
  getGTFSData.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 8, 24));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  svc = await import('./stationService.js');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ensureDataLoaded', () => {
  it('shares one load between concurrent callers', async () => {
    getGTFSData.mockResolvedValue({ stops, transfers: [] });
    await Promise.all([svc.ensureDataLoaded(), svc.ensureDataLoaded(), svc.ensureDataLoaded()]);
    expect(getGTFSData).toHaveBeenCalledTimes(1);
    expect(svc.getStopName('635')).toBe('14 St-Union Sq');
  });

  it('throws when the first load fails', async () => {
    getGTFSData.mockRejectedValue(new Error('S3 down'));
    await expect(svc.ensureDataLoaded()).rejects.toThrow('GTFS data loading failed');
  });

  it('keeps serving loaded data when a refresh fails, and waits before retrying', async () => {
    getGTFSData.mockResolvedValue({ stops, transfers: [] });
    await svc.ensureDataLoaded();

    getGTFSData.mockRejectedValue(new Error('S3 down'));
    vi.setSystemTime(Date.now() + DAY + 1);
    await expect(svc.ensureDataLoaded()).resolves.toBeUndefined();
    expect(svc.getStopsData()).toEqual(stops);

    // No retry storm: calls within 5 minutes don't hit the network again
    await svc.ensureDataLoaded();
    expect(getGTFSData).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    await svc.ensureDataLoaded();
    expect(getGTFSData).toHaveBeenCalledTimes(3);
  });
});
