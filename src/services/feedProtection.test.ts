import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import protobuf from 'protobufjs';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

let Message: protobuf.Type;
let fetchMTAData: typeof import('./mtaService.js').fetchMTAData;
let feeds: Map<string, any>;
let fetchMock: ReturnType<typeof vi.fn>;
const feedName = (url: string) => decodeURIComponent(url).split('/').pop()!;
const count = (data: any, line: string) => data.entity.filter((e: any) => e.tripUpdate?.trip.routeId === line).length;
const captured = new Map<string, any>();

beforeAll(async () => {
  const root = await protobuf.load(['src/schemas/gtfs-realtime.proto', 'src/schemas/nyct-subway.proto']);
  Message = root.lookupType('transit_realtime.FeedMessage');
  for (const name of ['before', 'partial', 'recovered']) {
    const bytes = gunzipSync(await readFile(new URL(`./fixtures/mta-numbered-2026-10-11/${name}.pb.gz`, import.meta.url)));
    captured.set(name, Message.toObject(Message.decode(bytes), { longs: String, enums: String, arrays: true }));
  }
});

function snapshot(routes: Record<string, number>, timestamp = Math.floor(Date.now() / 1000)) {
  return { header: { gtfsRealtimeVersion: '2.0', timestamp }, entity: Object.entries(routes).flatMap(([routeId, n]) =>
    Array.from({ length: n }, (_, i) => ({ id: `${routeId}-${i}`, tripUpdate: {
      trip: { routeId, tripId: `${routeId}-${i}`, startDate: '20261011' },
      stopTimeUpdate: [
        { stopId: '635N', stopSequence: 1, arrival: { time: timestamp + 600 } },
        { stopId: '601N', stopSequence: 2, arrival: { time: timestamp + 3600 } }
      ]
    } }))) };
}
const response = (feed: any) => new Response(Message.encode(Message.fromObject(feed)).finish());
async function seed(routes: Record<string, number>, name = 'gtfs') {
  feeds.set(name, snapshot(routes));
  await fetchMTAData();
  vi.setSystemTime(Date.now() + 30000);
}
const requestsFor = (name = 'gtfs') => fetchMock.mock.calls.filter(([url]) => feedName(url) === name).length;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 11, 18, 59));
  feeds = new Map();
  fetchMock = vi.fn(async (url: string) => response(feeds.get(feedName(url)) ?? snapshot({})));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ({ fetchMTAData } = await import('./mtaService.js'));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('partial feed protection', () => {
  it('replays the captured 190 → 156 → 190 sequence without publishing the gap or delaying callers', async () => {
    vi.setSystemTime(new Date('2026-10-11T18:59:03.619Z'));
    feeds.set('gtfs', captured.get('before'));
    expect(count(await fetchMTAData(), '3')).toBe(19);
    vi.setSystemTime(new Date('2026-10-11T18:59:08.757Z'));
    feeds.set('gtfs', captured.get('partial'));
    const held = await fetchMTAData(true);
    expect(count(held, '3')).toBe(19);
    expect(count(held, '5')).toBe(10);
    expect(held.feedStatus.staleFeeds).toEqual([]);
    expect(requestsFor()).toBe(2);
    // The actual recovered source timestamp is newer than the partial source.
    feeds.set('gtfs', captured.get('recovered'));
    await vi.advanceTimersByTimeAsync(5000);
    const recovered = await fetchMTAData();
    expect(count(recovered, '3')).toBe(19);
    expect(recovered.entity).toEqual(captured.get('recovered').entity);
    expect(requestsFor()).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(17); // 8 + 8 + only the affected feed
    expect(vi.mocked(console.info).mock.calls.some(([s]) => String(s).includes('feed_recovered'))).toBe(true);
  });

  it.each(['gtfs', 'gtfs-nqrw', 'gtfs-g', 'gtfs-ace', 'gtfs-bdfm', 'gtfs-jz', 'gtfs-l', 'gtfs-si'])(
    'protects %s and shares one retry among concurrent callers', async name => {
      await seed({ X: 20 }, name);
      feeds.set(name, snapshot({ X: 5 }));
      const results = await Promise.all([fetchMTAData(), fetchMTAData(), fetchMTAData()]);
      expect(results.every(result => count(result, 'X') === 20)).toBe(true);
      expect(requestsFor(name)).toBe(2);
      await vi.advanceTimersByTimeAsync(5000);
      expect(requestsFor(name)).toBe(3);
      await vi.advanceTimersByTimeAsync(10000);
      expect(requestsFor(name)).toBe(3);
    });

  it('detects a per-line collapse even when other lines keep the total unchanged', async () => {
    await seed({ '3': 20, '6': 80 });
    feeds.set('gtfs', snapshot({ '3': 5, '6': 95 }));
    expect(count(await fetchMTAData(), '3')).toBe(20);
  });

  it('accepts ordinary decreases without retrying', async () => {
    await seed({ '3': 20 });
    feeds.set('gtfs', snapshot({ '3': 18 }));
    expect(count(await fetchMTAData(), '3')).toBe(18);
    await vi.advanceTimersByTimeAsync(5000);
    expect(requestsFor()).toBe(2);
  });

  it('accepts a valid empty feed at startup', async () => {
    expect((await fetchMTAData()).entity).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(requestsFor()).toBe(1);
  });

  it('does not silently hold data over 60 seconds old, or compare baselines over two minutes old', async () => {
    await seed({ '3': 20 });
    vi.setSystemTime(Date.now() + 31000);
    feeds.set('gtfs', snapshot({ '3': 5 }));
    expect(count(await fetchMTAData(), '3')).toBe(5);
    await vi.advanceTimersByTimeAsync(5000);
    expect(requestsFor()).toBe(2);
    vi.mocked(console.info).mockClear();
    vi.setSystemTime(Date.now() + 121000);
    feeds.set('gtfs', snapshot({}));
    expect(count(await fetchMTAData(), '3')).toBe(0);
    expect(console.info).not.toHaveBeenCalled();
  });

  it('uses source age rather than fetch age to cap silent fallback at 60 seconds', async () => {
    feeds.set('gtfs', snapshot({ '3': 20 }, Math.floor(Date.now() / 1000) - 50));
    await fetchMTAData();
    feeds.set('gtfs', snapshot({ '3': 5 }));
    expect(count(await fetchMTAData(true), '3')).toBe(20);
    await vi.advanceTimersByTimeAsync(10000);
    expect(count(await fetchMTAData(), '3')).toBe(5);
  });

  it('accepts a persistent reduction at the fixed deadline, without extending it on repeated detections', async () => {
    await seed({ '3': 20 });
    feeds.set('gtfs', snapshot({ '3': 5 }));
    await fetchMTAData();
    await vi.advanceTimersByTimeAsync(10000);
    feeds.set('gtfs', snapshot({ '3': 4 }));
    expect(count(await fetchMTAData(true), '3')).toBe(20);
    await vi.advanceTimersByTimeAsync(10000);
    feeds.set('gtfs', snapshot({}));
    expect(count(await fetchMTAData(true), '3')).toBe(20);
    await vi.advanceTimersByTimeAsync(10000);
    expect(count(await fetchMTAData(), '3')).toBe(0);
  });

  it('does not treat a repeat of the partial source version as recovery', async () => {
    await seed({ '3': 20 });
    const partial = snapshot({ '3': 5 });
    feeds.set('gtfs', partial);
    await fetchMTAData();
    // Even an apparent count recovery needs a newer source revision.
    feeds.set('gtfs', snapshot({ '3': 19 }, partial.header.timestamp));
    await vi.advanceTimersByTimeAsync(5000);
    expect(count(await fetchMTAData(), '3')).toBe(20);
    expect(vi.mocked(console.info).mock.calls.some(([s]) => String(s).includes('feed_recovered'))).toBe(false);
  });

  it('carries cancellations, deleted entities, skipped stops and NO_DATA into fallback predictions', async () => {
    await seed({ '3': 20 });
    const partial: any = snapshot({ '3': 5 });
    partial.entity[0].tripUpdate.trip.scheduleRelationship = 'CANCELED';
    partial.entity[1].tripUpdate.stopTimeUpdate[0].scheduleRelationship = 'SKIPPED';
    partial.entity[2].tripUpdate.stopTimeUpdate[0].scheduleRelationship = 'NO_DATA';
    partial.entity[3].tripUpdate.trip.scheduleRelationship = 'DELETED';
    partial.entity[4] = { id: '3-4', isDeleted: true };
    feeds.set('gtfs', partial);
    const held = await fetchMTAData();
    expect(count(held, '3')).toBe(17);
    expect(held.entity.find((e: any) => e.id === '3-0')).toBeUndefined();
    expect(held.entity.find((e: any) => e.id === '3-1').tripUpdate.stopTimeUpdate[0].scheduleRelationship).toBe('SKIPPED');
    expect(held.entity.find((e: any) => e.id === '3-2').tripUpdate.stopTimeUpdate[0].scheduleRelationship).toBe('NO_DATA');
  });

  it('does not mistake finished trips for an incomplete feed', async () => {
    const initial: any = snapshot({ '3': 20 });
    initial.entity.slice(5).forEach((e: any) => { e.tripUpdate.stopTimeUpdate = [{ arrival: { time: Date.now() / 1000 + 10 } }]; });
    feeds.set('gtfs', initial);
    await fetchMTAData();
    vi.setSystemTime(Date.now() + 30000);
    feeds.set('gtfs', snapshot({ '3': 5 }));
    expect(count(await fetchMTAData(), '3')).toBe(5);
    await vi.advanceTimersByTimeAsync(5000);
    expect(requestsFor()).toBe(2);
  });

  it('bounds protection even when the background retry fails', async () => {
    await seed({ '3': 20 });
    feeds.set('gtfs', snapshot({ '3': 5 }));
    await fetchMTAData();
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(count(await fetchMTAData(), '3')).toBe(20);
    await vi.advanceTimersByTimeAsync(25000);
    expect(count(await fetchMTAData(), '3')).toBe(5);
    expect(vi.mocked(console.info).mock.calls.some(([s]) => String(s).includes('feed_retry_failed'))).toBe(true);
  });

  it('prevents a delayed retry from overwriting a newer regular refresh', async () => {
    await seed({ '3': 20 });
    feeds.set('gtfs', snapshot({ '3': 5 }));
    await fetchMTAData();
    let finish!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(5000);
    feeds.set('gtfs', snapshot({ '3': 22 }));
    expect(count(await fetchMTAData(true), '3')).toBe(22);
    finish(response(snapshot({ '3': 19 }, Math.floor(Date.now() / 1000) - 1)));
    await vi.advanceTimersByTimeAsync(0);
    expect(count(await fetchMTAData(), '3')).toBe(22);
  });

  it('rejects an older source version even if its request completed later', async () => {
    await seed({ '3': 20 });
    feeds.set('gtfs', snapshot({ '3': 25 }, Math.floor(Date.now() / 1000) - 60));
    expect(count(await fetchMTAData(), '3')).toBe(20);
  });

  it('does not extend unrelated feed cache lifetimes when the retry publishes recovery', async () => {
    await seed({ '3': 20 });
    feeds.set('gtfs', snapshot({ '3': 5 }));
    await fetchMTAData();
    vi.setSystemTime(Date.now() + 1000);
    feeds.set('gtfs', snapshot({ '3': 20 }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(requestsFor('gtfs-l')).toBe(2);
    await vi.advanceTimersByTimeAsync(25000);
    await fetchMTAData();
    expect(requestsFor('gtfs-l')).toBe(3);
  });
});
