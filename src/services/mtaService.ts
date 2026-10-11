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

// Last successful response per feed, used when that feed fails on a later fetch
const lastGoodFeeds: Record<string, { entity: any[]; header: any; fetchedAt: number }> = {};
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

/**
 * All 8 subway GTFS-RT feeds combined. Cached for 30s; concurrent callers share one fetch.
 * A feed that fails falls back to its last good data (up to 5 minutes old); feeds with no
 * usable data are listed in feedStatus.failedFeeds. Throws only if no feed has data.
 */
export async function fetchMTAData(forceRefresh = false) {
  if (!forceRefresh && cachedData && Date.now() < cacheExpiresAt) {
    return cachedData;
  }

  inFlight ??= fetchAllFeeds().finally(() => { inFlight = null; });
  return inFlight;
}

async function fetchAllFeeds() {
  const feedKeys = Object.keys(MTA_FEEDS);
  const allFeeds = await Promise.allSettled(
    Object.values(MTA_FEEDS).map(url => fetchSingleFeed(url))
  );
  const now = Date.now();
  let expiresAt = now + CACHE_DURATION_MS;

  const combinedData = {
    entity: [] as any[],
    header: null as any,
    feedStatus: {
      successful: 0,
      failed: 0,
      failedFeeds: [] as string[],
      staleFeeds: [] as string[]
    }
  };

  allFeeds.forEach((result, index) => {
    const feedName = feedKeys[index];
    let feed: { entity: any[]; header: any } | null = null;

    if (result.status === 'fulfilled') {
      feed = { entity: result.value.entity, header: result.value.header };
      const feedTime = Number(feed.header?.timestamp) * 1000;
      lastGoodFeeds[feedName] = { ...feed, fetchedAt: Number.isFinite(feedTime) ? Math.min(now, feedTime) : now };
      combinedData.feedStatus.successful++;
    } else {
      combinedData.feedStatus.failed++;
      console.error(`Failed to fetch feed ${feedName}: ${result.reason?.message ?? result.reason}`);

      const lastGood = lastGoodFeeds[feedName];
      if (lastGood && now - lastGood.fetchedAt < MAX_FEED_STALENESS_MS) {
        feed = lastGood;
        combinedData.feedStatus.staleFeeds.push(feedName);
      } else {
        combinedData.feedStatus.failedFeeds.push(feedName);
      }
    }

    if (feed) {
      expiresAt = Math.min(expiresAt, lastGoodFeeds[feedName].fetchedAt + MAX_FEED_STALENESS_MS);
      combinedData.entity.push(...feed.entity);
      combinedData.header ??= feed.header;
    }
  });

  if (combinedData.feedStatus.failedFeeds.length === feedKeys.length) {
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
