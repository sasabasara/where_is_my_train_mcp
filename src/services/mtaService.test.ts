import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import protobuf from 'protobufjs';

let encodeFeed: (routeId: string) => Uint8Array;

beforeAll(async () => {
  const root = await protobuf.load(['src/schemas/gtfs-realtime.proto', 'src/schemas/nyct-subway.proto']);
  const FeedMessage = root.lookupType('transit_realtime.FeedMessage');
  encodeFeed = (routeId) => FeedMessage.encode(FeedMessage.fromObject({
    header: { gtfsRealtimeVersion: '2.0' },
    entity: [{ id: routeId, tripUpdate: { trip: { routeId } } }]
  })).finish();
});

// Which feeds fail on the next fetch, keyed by a substring of the feed URL
let failing = new Set<string>();
const fetchMock = vi.fn(async (url: string) => {
  const key = decodeURIComponent(url).split('/').pop()!; // e.g. "gtfs-l", "gtfs"
  if (failing.has(key) || failing.has('*')) return new Response('down', { status: 503 });
  return new Response(encodeFeed(key));
});

let fetchMTAData: typeof import('./mtaService.js').fetchMTAData;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 8, 24, 1, 0, 0));
  fetchMock.mockClear();
  failing = new Set();
  ({ fetchMTAData } = await import('./mtaService.js'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const routes = (data: any) => data.entity.map((e: any) => e.tripUpdate.trip.routeId).sort();

describe('fetchMTAData', () => {
  it('combines all 8 feeds', async () => {
    const data = await fetchMTAData();
    expect(data.entity).toHaveLength(8);
    expect(data.feedStatus).toMatchObject({ successful: 8, failed: 0, failedFeeds: [], staleFeeds: [] });
  });

  it('shares one fetch between concurrent callers', async () => {
    await Promise.all([fetchMTAData(), fetchMTAData(), fetchMTAData()]);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('reports a failed feed with no previous data', async () => {
    failing.add('gtfs-l');
    const data = await fetchMTAData();
    expect(routes(data)).not.toContain('gtfs-l');
    expect(data.feedStatus.failedFeeds).toEqual(['l']);
  });

  it('keeps serving a failed feed from its last good fetch for up to 5 minutes', async () => {
    await fetchMTAData();
    failing.add('gtfs-l');

    vi.setSystemTime(Date.now() + 60_000);
    const recent = await fetchMTAData();
    expect(routes(recent)).toContain('gtfs-l');
    expect(recent.feedStatus).toMatchObject({ staleFeeds: ['l'], failedFeeds: [] });

    vi.setSystemTime(Date.now() + 5 * 60_000);
    const old = await fetchMTAData();
    expect(routes(old)).not.toContain('gtfs-l');
    expect(old.feedStatus.failedFeeds).toEqual(['l']);
  });

  it('throws instead of reporting zero trains when every feed is down', async () => {
    failing.add('*');
    await expect(fetchMTAData()).rejects.toThrow(/All MTA real-time feeds unavailable/);
  });
});
