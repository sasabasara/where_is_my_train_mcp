import protobuf from "protobufjs";

const MTA_FEEDS = {
  'nqrw': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw',
  '1234567s': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
  'g': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g',
  'ace': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
  'bdfm': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
  'jz': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz',
  'l': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l',
  'si': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si'
};

const gtfsRootPromise: Promise<protobuf.Root> = protobuf.load([
  "src/schemas/gtfs-realtime.proto",
  "src/schemas/nyct-subway.proto"
]);

let cachedData: any = null;
let cacheExpiresAt = 0;
let inFlight: Promise<any> | null = null;
const CACHE_DURATION_MS = 30000; // 30 seconds

type Feed = { entity: any[]; header: any; fetchedAt: number };
type Protection = {
  candidate: Feed;
  counts: Map<string, number>;
  deadline: number;
  startedAt: number;
  timer?: ReturnType<typeof setTimeout>;
};
// Accepted snapshots remain separate from suspicious candidates until recovery or expiry.
const lastGoodFeeds: Record<string, Feed> = {};
const protections = new Map<string, Protection>();
const feedErrors = new Set<string>();
const revisions: Record<string, number> = {};
let refreshExpiresAt = 0;
const RETRY_DELAY_MS = 5000;
const PROTECTION_MS = 30000;
const SILENT_FALLBACK_AGE_MS = 60000;
const COMPARISON_AGE_MS = 120000;
const MAX_FEED_STALENESS_MS = 5 * 60 * 1000;

async function fetchSingleFeed(url: string) {
  const root = await gtfsRootPromise;
  const FeedMessage = root.lookupType("transit_realtime.FeedMessage");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'whereismytrain-mcp/1.0'
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    if (buffer.length === 0) {
      throw new Error('Empty response from feed');
    }

    const message = FeedMessage.decode(buffer);
    const decoded = FeedMessage.toObject(message, {
      longs: String,
      enums: String,
      bytes: String,
      arrays: true
    });

    if (!decoded || !Array.isArray(decoded.entity)) {
      throw new Error('Invalid feed structure');
    }
    const feedTime = Number(decoded.header?.timestamp) * 1000;
    if (Number.isFinite(feedTime) && Date.now() - feedTime >= MAX_FEED_STALENESS_MS) {
      throw new Error('Feed timestamp is more than five minutes old');
    }

    return decoded;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error('Feed request timed out after 10 seconds');
    }
    throw error;
  } finally {
    // Keep the deadline active while reading the body, not just until headers arrive.
    clearTimeout(timeoutId);
  }
}

function sourceTime(feed: Feed): number {
  return Number(feed.header?.timestamp) * 1000;
}

function tripKey(entity: any): string {
  const trip = entity.tripUpdate?.trip;
  return trip?.tripId
    ? JSON.stringify([trip.routeId, trip.tripId, trip.startDate])
    : `entity:${entity.id}`;
}

function tripCounts(feed: Feed, now: number): Map<string, number> {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const entity of feed.entity) {
    const update = entity.tripUpdate;
    const trip = update?.trip;
    if (!trip || entity.isDeleted || ['CANCELED', 'DELETED'].includes(trip.scheduleRelationship)) continue;
    const times = (update.stopTimeUpdate ?? []).flatMap((stop: any) =>
      [Number(stop.arrival?.time), Number(stop.departure?.time)].filter(Number.isFinite));
    if (times.length && Math.max(...times) * 1000 <= now) continue;
    const key = tripKey(entity);
    if (seen.has(key)) continue;
    seen.add(key);
    counts.set(trip.routeId, (counts.get(trip.routeId) ?? 0) + 1);
  }
  return counts;
}

function suspiciousDrop(before: Map<string, number>, after: Map<string, number>): boolean {
  const total = (counts: Map<string, number>) => [...counts.values()].reduce((a, b) => a + b, 0);
  const previous = total(before), next = total(after);
  if (previous - next >= 10 && next <= previous * 0.85) return true;
  return [...before].some(([line, count]) => count - (after.get(line) ?? 0) >= 5 && (after.get(line) ?? 0) <= count * 0.5);
}

// Carry explicit withdrawals into the fallback, without merging ordinary predictions
// from two snapshots. Missing entities alone are not cancellation instructions.
function applyWithdrawals(previous: Feed, incoming: Feed): Feed {
  const updates = new Map(incoming.entity.map(entity => [tripKey(entity), entity]));
  const deletedIds = new Set(incoming.entity.filter(e => e.isDeleted).map(e => e.id));
  return { ...previous, entity: previous.entity.flatMap(entity => {
    const newer = updates.get(tripKey(entity));
    if (deletedIds.has(entity.id) || newer?.isDeleted ||
        ['CANCELED', 'DELETED'].includes(newer?.tripUpdate?.trip?.scheduleRelationship)) return [];
    const withdrawals = (newer?.tripUpdate?.stopTimeUpdate ?? []).filter((stop: any) =>
      ['SKIPPED', 'NO_DATA'].includes(stop.scheduleRelationship));
    if (!withdrawals.length || !entity.tripUpdate) return [entity];
    return [{ ...entity, tripUpdate: { ...entity.tripUpdate,
      stopTimeUpdate: (entity.tripUpdate.stopTimeUpdate ?? []).map((stop: any) => {
        const withdrawal = withdrawals.find((s: any) => s.stopSequence != null && stop.stopSequence != null
          ? s.stopSequence === stop.stopSequence : s.stopId != null && s.stopId === stop.stopId);
        return withdrawal ? { ...stop, scheduleRelationship: withdrawal.scheduleRelationship } : stop;
      })
    } }];
  }) };
}

function logProtection(event: string, feed: string, details: Record<string, unknown> = {}) {
  console.info(JSON.stringify({ event: `feed_${event}`, feed, ...details }));
}

function acceptFeed(name: string, feed: Feed) {
  const protection = protections.get(name);
  if (protection?.timer) clearTimeout(protection.timer);
  protections.delete(name);
  lastGoodFeeds[name] = feed;
}

function expireProtections(now: number) {
  for (const [name, protection] of protections) {
    if (now < protection.deadline) continue;
    logProtection('protection_expired', name, { heldForMs: now - protection.startedAt,
      sourceAgeMs: now - protection.candidate.fetchedAt });
    acceptFeed(name, protection.candidate);
  }
}

function selectFeed(name: string, decoded: any) {
  const now = Date.now();
  const timestamp = Number(decoded.header?.timestamp) * 1000;
  const candidate: Feed = { entity: decoded.entity, header: decoded.header,
    fetchedAt: Number.isFinite(timestamp) ? Math.min(now, timestamp) : now };
  const previous = lastGoodFeeds[name];
  const protection = protections.get(name);
  // Source timestamps, as well as request revisions, prevent out-of-order replacement.
  if (previous && sourceTime(candidate) < sourceTime(protection?.candidate ?? previous)) return;
  feedErrors.delete(name);
  if (protection) {
    const newerVersion = sourceTime(candidate) > sourceTime(protection.candidate);
    protection.candidate = candidate;
    lastGoodFeeds[name] = applyWithdrawals(previous, candidate);
    if (now >= protection.deadline) {
      expireProtections(now);
    } else if (newerVersion && !suspiciousDrop(protection.counts, tripCounts(candidate, now))) {
      logProtection('recovered', name, { heldForMs: now - protection.startedAt,
        sourceAgeMs: now - candidate.fetchedAt });
      acceptFeed(name, candidate);
    }
    return;
  }
  const before = previous && tripCounts(previous, now);
  const after = tripCounts(candidate, now);
  if (previous && now - previous.fetchedAt < COMPARISON_AGE_MS && suspiciousDrop(before!, after)) {
    const canProtect = Number.isFinite(sourceTime(previous)) && now - sourceTime(previous) < SILENT_FALLBACK_AGE_MS;
    logProtection('drop_detected', name, { before: Object.fromEntries(before!), after: Object.fromEntries(after),
      protected: canProtect, sourceAgeMs: now - previous.fetchedAt });
    if (canProtect) {
      const pending: Protection = { candidate, counts: before!, startedAt: now,
        deadline: Math.min(now + PROTECTION_MS, sourceTime(previous) + SILENT_FALLBACK_AGE_MS) };
      lastGoodFeeds[name] = applyWithdrawals(previous, candidate);
      protections.set(name, pending);
      pending.timer = setTimeout(() => {
        void retryFeed(name, pending).catch(() => {
          console.error(`Background feed retry failed for ${name}`);
        });
      }, RETRY_DELAY_MS);
      pending.timer.unref();
      return;
    }
  }
  acceptFeed(name, candidate);
}

async function retryFeed(name: string, protection: Protection) {
  if (protections.get(name) !== protection || Date.now() >= protection.deadline) return;
  const revision = revisions[name] = (revisions[name] ?? 0) + 1;
  try {
    const decoded = await fetchSingleFeed(MTA_FEEDS[name as keyof typeof MTA_FEEDS]);
    if (revisions[name] !== revision || protections.get(name) !== protection) return;
    selectFeed(name, decoded);
    if (protections.has(name)) logProtection('retry_short', name, { sourceAgeMs: Date.now() - protection.candidate.fetchedAt });
    rebuildCache(); // Publish recovery immediately, without extending the other feeds' TTL.
  } catch {
    if (revisions[name] !== revision || protections.get(name) !== protection) return;
    logProtection('retry_failed', name);
    // The original candidate is valid: a failed recheck must not extend protection.
    rebuildCache();
  }
}

/** All eight feeds share a 30-second cache and one in-flight refresh. Suspicious
 * drops get one background retry while recent accepted predictions remain available. */
export async function fetchMTAData(forceRefresh = false) {
  if ([...protections.values()].some(p => Date.now() >= p.deadline)) rebuildCache();
  if (!forceRefresh && cachedData && Date.now() < cacheExpiresAt) return cachedData;
  inFlight ??= fetchAllFeeds().finally(() => { inFlight = null; });
  return inFlight;
}

async function fetchAllFeeds() {
  await Promise.all(Object.entries(MTA_FEEDS).map(async ([name, url]) => {
    const revision = revisions[name] = (revisions[name] ?? 0) + 1;
    try {
      const decoded = await fetchSingleFeed(url);
      if (revisions[name] === revision) selectFeed(name, decoded);
    } catch (error: any) {
      if (revisions[name] !== revision) return;
      feedErrors.add(name);
      console.error(`Failed to fetch feed ${name}: ${error?.message ?? error}`);
    }
  }));
  refreshExpiresAt = Date.now() + CACHE_DURATION_MS;
  return rebuildCache();
}

function rebuildCache() {
  const now = Date.now();
  expireProtections(now);
  let expiresAt = refreshExpiresAt;
  const combinedData = {
    entity: [] as any[], header: null as any,
    feedStatus: { successful: 0, failed: 0, failedFeeds: [] as string[], staleFeeds: [] as string[] }
  };
  for (const name of Object.keys(MTA_FEEDS)) {
    const feed = lastGoodFeeds[name];
    const usable = feed && now - feed.fetchedAt < MAX_FEED_STALENESS_MS;
    if (feedErrors.has(name) || !usable) {
      combinedData.feedStatus.failed++;
      if (usable) combinedData.feedStatus.staleFeeds.push(name);
      else combinedData.feedStatus.failedFeeds.push(name);
    } else {
      combinedData.feedStatus.successful++;
    }
    if (usable) {
      expiresAt = Math.min(expiresAt, feed.fetchedAt + MAX_FEED_STALENESS_MS);
      combinedData.entity.push(...feed.entity);
      combinedData.header ??= feed.header;
    }
  }
  if (combinedData.feedStatus.failedFeeds.length === Object.keys(MTA_FEEDS).length) {
    throw new Error('All MTA real-time feeds unavailable');
  }
  cachedData = combinedData;
  cacheExpiresAt = expiresAt;
  return combinedData;
}

async function fetchJSON(url: string, label: string): Promise<any> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'whereismytrain-mcp/1.0'
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    return await res.json();
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error(`${label} request timed out after 10 seconds`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// JSON flavour of the alerts feed: same GTFS-RT shape, but with the MTA "Mercury"
// extension (alert_type, priority, created/updated) already decoded.
// Share concurrent calls and cache successful results for 30 seconds. Expired outage/alert
// data is never silently served as current when a refresh fails.
function cachedJSON<T>(load: () => Promise<T>): () => Promise<T> {
  let value: T;
  let fetchedAt = 0;
  let pending: Promise<T> | null = null;
  return () => {
    if (fetchedAt > 0 && Date.now() - fetchedAt < CACHE_DURATION_MS) return Promise.resolve(value);
    pending ??= load().then(result => {
      value = result;
      fetchedAt = Date.now();
      return result;
    }).finally(() => { pending = null; });
    return pending;
  };
}

export const fetchMTAAlerts = cachedJSON(async () => {
  const data = await fetchJSON(
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json",
    "Alerts"
  );

  if (!data || !Array.isArray(data.entity)) {
    throw new Error('Invalid alerts feed structure');
  }

  return data;
});

export const fetchEquipmentOutages = cachedJSON(async () => {
  const data = await fetchJSON(
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene.json",
    "Equipment outage"
  );

  if (!Array.isArray(data)) {
    throw new Error('Invalid equipment outage data structure');
  }

  return data;
});

// Full elevator/escalator inventory (~700 rows, rarely changes) — cached for a day
let equipmentListCache: any[] | null = null;
let equipmentListFetchedAt = 0;
const EQUIPMENT_LIST_TTL_MS = 24 * 60 * 60 * 1000;

export async function fetchEquipmentList(): Promise<any[]> {
  if (equipmentListCache && Date.now() - equipmentListFetchedAt < EQUIPMENT_LIST_TTL_MS) {
    return equipmentListCache;
  }

  try {
    const data = await fetchJSON(
      "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene_equipments.json",
      "Equipment list"
    );
    if (!Array.isArray(data)) {
      throw new Error('Invalid equipment list structure');
    }
    equipmentListCache = data;
    equipmentListFetchedAt = Date.now();
    return data;
  } catch (error) {
    // Enrichment only — serve stale data (or nothing) rather than fail the outage lookup
    console.error('Failed to fetch equipment list:', error instanceof Error ? error.message : error);
    return equipmentListCache ?? [];
  }
}
