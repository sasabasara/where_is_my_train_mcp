import fetch from "node-fetch";
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

export async function fetchMTAData() {
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
  
  if (combinedData.feedStatus.failed > 0) {
    console.warn(`⚠️  ${combinedData.feedStatus.failed}/${feedKeys.length} feeds failed: ${combinedData.feedStatus.failedFeeds.join(', ')}`);
  }
  
  return combinedData;
}

export async function fetchMTAAlerts() {
  const root = await gtfsRootPromise;
  const FeedMessage = root.lookupType("transit_realtime.FeedMessage");

  const url = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts";
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
      throw new Error('Empty alerts response');
    }

    const message = FeedMessage.decode(buffer);
    const decoded = FeedMessage.toObject(message, {
      longs: String,
      enums: String,
      bytes: String
    });

    if (!decoded || !Array.isArray(decoded.entity)) {
      throw new Error('Invalid alerts feed structure');
    }

    return decoded;
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Alerts request timed out after 10 seconds');
    }
    throw error;
  }
}

export async function fetchEquipmentOutages() {
  const url = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene.json";
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

    const data = await res.json();

    if (!Array.isArray(data)) {
      throw new Error('Invalid equipment outage data structure');
    }

    return data;
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Equipment outage request timed out after 10 seconds');
    }
    throw error;
  }
}
