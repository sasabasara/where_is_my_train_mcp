import { StationMapper } from "../services/stationMapper.js";

const stationMapper = new StationMapper();

export function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

export async function getTrainDestination(stopTimeUpdates: any[]): Promise<string> {
  const lastStop = stopTimeUpdates[stopTimeUpdates.length - 1];
  return lastStop ? await stationMapper.getStationName(lastStop.stopId) : 'Unknown destination';
}

export function getMTADisclaimer(): string {
  return '\n\n⚠️ Data provided "as is" without warranty. Source: MTA. Not endorsed by MTA.';
}

export async function getCurrentLocation(vehicle: any): Promise<string> {
  if (!vehicle?.stopId) return '';
  
  const currentStationName = await stationMapper.getStationName(vehicle.stopId);
  const statusText = vehicle.currentStatus === 0 ? 'approaching' : 
                    vehicle.currentStatus === 1 ? 'at' : 'departed from';
  return `currently ${statusText} ${currentStationName}`;
}
