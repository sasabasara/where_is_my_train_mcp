import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import * as path from 'path';
import * as https from 'https';
import { createWriteStream } from 'fs';
import StreamZip from 'node-stream-zip';
import { parseCSV } from '../utils/csvParser';

interface GTFSConfig {
  url: string;
  cacheDir: string;
  cacheDurationMs: number;
  name: string;
}

export class GTFSManager {
  private static readonly GTFS_CONFIGS: GTFSConfig[] = [
    {
      url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip',
      cacheDir: 'cache/gtfs_regular',
      cacheDurationMs: 30 * 24 * 60 * 60 * 1000,
      name: 'regular'
    },
    {
      url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip',
      cacheDir: 'cache/gtfs_supplemented', 
      cacheDurationMs: 50 * 60 * 1000,
      name: 'supplemented'
    }
  ];

  private static readonly REQUIRED_FILES = [
    'stops.txt', 
    'transfers.txt', 
    'routes.txt'
  ];

  public static async getGTFSData(type: 'regular' | 'supplemented'): Promise<{
    stops: any[];
    transfers: any[];
    routes: any[];
  }> {
    const config = this.GTFS_CONFIGS.find(c => c.name === type);
    if (!config) throw new Error(`Unknown GTFS type: ${type}`);

    await this.ensureFreshData(config);
    return this.loadCachedData(config);
  }

  private static async ensureFreshData(config: GTFSConfig): Promise<void> {
    const cacheValid = await this.isCacheValid(config);
    
    if (!cacheValid) {
      await this.downloadAndExtract(config);
    }
  }

  private static async isCacheValid(config: GTFSConfig): Promise<boolean> {
    try {
      const cacheDir = path.join(process.cwd(), config.cacheDir);
      await fs.access(cacheDir, fsConstants.F_OK);
      
      const timestampFile = path.join(cacheDir, '.timestamp');
      await fs.access(timestampFile, fsConstants.F_OK);
      
      const allFilesExist = await Promise.all(this.REQUIRED_FILES.map(file => 
        fs.access(path.join(cacheDir, file), fsConstants.F_OK).then(() => true).catch(() => false)
      ));
      
      if (!allFilesExist.every(Boolean)) {
        return false;
      }

      const timestamp = parseInt(await fs.readFile(timestampFile, 'utf-8'));
      const age = Date.now() - timestamp;
      
      return age < config.cacheDurationMs;
    } catch {
      return false;
    }
  }

  private static async downloadAndExtract(config: GTFSConfig): Promise<void> {
    const cacheDir = path.join(process.cwd(), config.cacheDir);
    const zipPath = path.join(cacheDir, 'gtfs.zip');
    
    await fs.mkdir(cacheDir, { recursive: true });

    await this.downloadFile(config.url, zipPath);
    
    await this.extractRequiredFiles(zipPath, cacheDir);
    
    await this.validateExtractedFiles(cacheDir);
    
    await fs.writeFile(
      path.join(cacheDir, '.timestamp'), 
      Date.now().toString()
    );
    
    await fs.unlink(zipPath);
  }

  private static async downloadFile(url: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = createWriteStream(outputPath);
      
      https.get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
          return;
        }
        
        response.pipe(file);
        
        file.on('finish', () => {
          file.close();
          resolve();
        });
        
        file.on('error', reject);
      }).on('error', reject);
    });
  }

  private static async extractRequiredFiles(zipPath: string, outputDir: string): Promise<void> {
    const zip = new StreamZip.async({ file: zipPath });
    
    try {
      const entries = await zip.entries();
      const targetFiles = this.REQUIRED_FILES;
      let extractedCount = 0;
      
      for (const [fileName, entry] of Object.entries(entries)) {
        if (targetFiles.includes(fileName)) {
          const outputPath = path.join(outputDir, fileName);
          await zip.extract(fileName, outputPath);
          extractedCount++;
        }
      }
      
      if (extractedCount === 0) {
        throw new Error(`No required GTFS files found in ZIP archive`);
      }
      
    } finally {
      await zip.close();
    }
  }

  private static async validateExtractedFiles(cacheDir: string): Promise<void> {
    for (const fileName of this.REQUIRED_FILES) {
      const filePath = path.join(cacheDir, fileName);
      try {
        await fs.access(filePath, fsConstants.F_OK);
      } catch {
        throw new Error(`Required file ${fileName} was not extracted successfully`);
      }
    }
  }

  private static async loadCachedData(config: GTFSConfig): Promise<{
    stops: any[];
    transfers: any[];
    routes: any[];
  }> {
    const cacheDir = path.join(process.cwd(), config.cacheDir);
    
    const [stops, transfers, routes] = await Promise.all([
      this.parseCSVFile(path.join(cacheDir, 'stops.txt')),
      this.parseCSVFile(path.join(cacheDir, 'transfers.txt')),
      this.parseCSVFile(path.join(cacheDir, 'routes.txt')),
    ]);
    
    return { stops, transfers, routes };
  }

  /**
   * Parse CSV file using centralized utility
   */
  private static async parseCSVFile(filePath: string): Promise<any[]> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return parseCSV(content);
    } catch (error) {
      console.error(`Failed to parse ${filePath}:`, error);
      return [];
    }
  }

  /**
   * Force refresh of specific GTFS type
   */
  public static async forceRefresh(type: 'regular' | 'supplemented'): Promise<void> {
    const config = this.GTFS_CONFIGS.find(c => c.name === type);
    if (!config) throw new Error(`Unknown GTFS type: ${type}`);

    const timestampFile = path.join(process.cwd(), config.cacheDir, '.timestamp');
    try {
      await fs.unlink(timestampFile);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    await this.ensureFreshData(config);
  }

  /**
   * Get cache status for monitoring
   */
  public static async getCacheStatus(): Promise<{ regular: any; supplemented: any }> {
    const getStatus = async (config: GTFSConfig) => {
      try {
        const timestampFile = path.join(process.cwd(), config.cacheDir, '.timestamp');
        const timestampContent = await fs.readFile(timestampFile, 'utf-8');
        const timestamp = parseInt(timestampContent);
        const age = Date.now() - timestamp;
        const nextUpdate = timestamp + config.cacheDurationMs;

        return {
          cached: true,
          age: Math.floor(age / 1000 / 60),
          nextUpdate: new Date(nextUpdate).toISOString(),
          stale: age > config.cacheDurationMs
        };
      } catch {
        return { cached: false, age: null, nextUpdate: null };
      }
    };

    const [regular, supplemented] = await Promise.all([
      getStatus(this.GTFS_CONFIGS[0]),
      getStatus(this.GTFS_CONFIGS[1])
    ]);

    return { regular, supplemented };
  }
}
