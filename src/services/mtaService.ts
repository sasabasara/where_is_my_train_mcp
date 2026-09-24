import protobuf from "protobufjs";

let gtfsRootPromise: Promise<protobuf.Root>;

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

const initializeGTFS = (): Promise<protobuf.Root> => {
  if (!gtfsRootPromise) {
    gtfsRootPromise = protobuf.load(["src/schemas/gtfs-realtime.proto", "src/schemas/nyct-subway.proto"]);
  }
  return gtfsRootPromise;
};

// Initialize the promise on module load
gtfsRootPromise = initializeGTFS();

// Simple in-memory cache
let cachedData: any = null;
let lastFetchTime = 0;
const CACHE_DURATION_MS = 30000; // 30 seconds

export function getCachedData() {
  return cachedData;
}

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

    clearTimeout(timeoutId);

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
      bytes: String
    });

    if (!decoded || !Array.isArray(decoded.entity)) {
      throw new Error('Invalid feed structure');
    }

    return decoded;
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Feed request timed out after 10 seconds');
    }
    throw error;
  }
}

export async function fetchMTAData(forceRefresh = false) {
  // Return cached data if valid and not forcing refresh
  if (!forceRefresh && cachedData && (Date.now() - lastFetchTime < CACHE_DURATION_MS)) {
    return cachedData;
  }

  const feedKeys = Object.keys(MTA_FEEDS);
  const feedUrls = Object.values(MTA_FEEDS);

  const allFeeds = await Promise.allSettled(
    feedUrls.map(url => fetchSingleFeed(url))
  );

  const combinedData = {
    entity: [] as any[],
    header: null as any,
    feedStatus: {
      successful: 0,
      failed: 0,
      failedFeeds: [] as string[]
    }
  };

  allFeeds.forEach((result, index) => {
    const feedName = feedKeys[index];
    if (result.status === 'fulfilled') {
      const feedData = result.value;
      if (feedData && feedData.entity) {
        combinedData.entity.push(...feedData.entity);
        combinedData.feedStatus.successful++;
      }
      if (!combinedData.header && feedData.header) {
        combinedData.header = feedData.header;
      }
    } else {
      combinedData.feedStatus.failed++;
      combinedData.feedStatus.failedFeeds.push(feedName);
      console.error(`Failed to fetch feed ${feedName}`);
    }
  });



  // Update cache
  cachedData = combinedData;
  lastFetchTime = Date.now();

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
export async function fetchMTAAlerts() {
  const data = await fetchJSON(
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json",
    "Alerts"
  );

  if (!data || !Array.isArray(data.entity)) {
    throw new Error('Invalid alerts feed structure');
  }

  return data;
}

export async function fetchEquipmentOutages() {
  const data = await fetchJSON(
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene.json",
    "Equipment outage"
  );

  if (!Array.isArray(data)) {
    throw new Error('Invalid equipment outage data structure');
  }

  return data;
}

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
