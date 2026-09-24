import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import StreamZip from 'node-stream-zip';
import { parseCSV } from '../utils/csvParser.js';

// Static subway GTFS. Only stops.txt and transfers.txt are used (station names/locations
// and transfer links); they are identical in the 20MB "supplemented" feed, so we use the
// 5.6MB regular feed and refresh it rarely.
const GTFS_URL = 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip';
const CACHE_DIR = path.join(process.cwd(), 'cache/gtfs_regular');
const CACHE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const REQUIRED_FILES = ['stops.txt', 'transfers.txt'];

export class GTFSManager {
  /**
   * Stops and transfers from the local cache, downloading first if the cache is missing or older than a week.
   */
  public static async getGTFSData(): Promise<{ stops: any[]; transfers: any[] }> {
    if (!(await this.isCacheValid())) {
      await this.downloadAndExtract();
    }
    return this.loadCachedData();
  }

  private static async isCacheValid(): Promise<boolean> {
    try {
      const timestamp = parseInt(await fs.readFile(path.join(CACHE_DIR, '.timestamp'), 'utf-8'));
      if (Date.now() - timestamp >= CACHE_DURATION_MS) return false;

      await Promise.all(REQUIRED_FILES.map(file => fs.access(path.join(CACHE_DIR, file))));
      return true;
    } catch {
      return false;
    }
  }

  private static async downloadAndExtract(): Promise<void> {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const zipPath = path.join(CACHE_DIR, 'gtfs.zip');

    try {
      const res = await fetch(GTFS_URL, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(zipPath));

      // Extract to temp names, then rename, so a failed extract never leaves half-written files
      const zip = new StreamZip.async({ file: zipPath });
      try {
        for (const file of REQUIRED_FILES) {
          await zip.extract(file, path.join(CACHE_DIR, `${file}.tmp`));
        }
      } finally {
        await zip.close();
      }
      for (const file of REQUIRED_FILES) {
        await fs.rename(path.join(CACHE_DIR, `${file}.tmp`), path.join(CACHE_DIR, file));
      }

      await fs.writeFile(path.join(CACHE_DIR, '.timestamp'), Date.now().toString());
    } finally {
      await fs.rm(zipPath, { force: true });
    }
  }

  private static async loadCachedData(): Promise<{ stops: any[]; transfers: any[] }> {
    const [stops, transfers] = await Promise.all(
      REQUIRED_FILES.map(async file => parseCSV(await fs.readFile(path.join(CACHE_DIR, file), 'utf-8')))
    );
    return { stops, transfers };
  }
}
