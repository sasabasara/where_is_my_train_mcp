import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-11T18:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe.each(['fetchMTAAlerts', 'fetchEquipmentOutages'] as const)('%s cache', name => {
  it('shares concurrent requests, caches for 30 seconds, and refreshes at expiry', async () => {
    const data = name === 'fetchMTAAlerts' ? { entity: [] } : [];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(data)));
    vi.stubGlobal('fetch', fetchMock);
    const load = (await import('./mtaService.js'))[name];
    await Promise.all([load(), load(), load()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(29_999);
    await load();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await load();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not present expired data as current when refresh fails, and recovers next call', async () => {
    const data = name === 'fetchMTAAlerts' ? { entity: [] } : [];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(data)));
    vi.stubGlobal('fetch', fetchMock);
    const load = (await import('./mtaService.js'))[name];
    await load();
    vi.advanceTimersByTime(30_000);
    fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    await expect(load()).rejects.toThrow('503');
    await expect(load()).resolves.toEqual(data);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
