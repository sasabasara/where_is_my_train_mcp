import { DynamicLineService } from './dynamicLineService.js';
import { StationMapper } from './stationMapper.js';
import type { AlertCategory, AlertSeverity, ServiceDisruptionsArgs, SubwayAlert } from '../types/index.js';

export interface DisruptionInfo {
  lines: string[];
  severity: AlertSeverity;
  category: AlertCategory;
  alertType: string | null;
  title: string;
  description: string | null;
  affectedStations: string[];
  activeUntil: number | null;
}

export class ServiceDisruptionAnalyzer {
  private static stationMapper = new StationMapper();

  /**
   * @param alerts Currently active alerts, already filtered by line/severity and sorted most severe first
   */
  static async analyze(params: ServiceDisruptionsArgs, alerts: SubwayAlert[]) {
    const serviceContext = DynamicLineService.getServiceContext();
    let disruptions = await Promise.all(alerts.map(alert => this.toDisruption(alert)));

    if (params.location) {
      const locationLower = params.location.toLowerCase();
      disruptions = disruptions.filter(d =>
        d.affectedStations.some(station => station.toLowerCase().includes(locationLower)) ||
        d.title.toLowerCase().includes(locationLower) ||
        (d.description ?? '').toLowerCase().includes(locationLower)
      );
    }

    const count = (severity: AlertSeverity) => disruptions.filter(d => d.severity === severity).length;
    const counts = {
      total: disruptions.length,
      critical: count('CRITICAL'),
      major: count('MAJOR'),
      minor: count('MINOR'),
      planned: count('PLANNED')
    };

    let systemStatus: 'normal' | 'service_changes' | 'disrupted' = 'normal';
    if (counts.critical + counts.major > 0) systemStatus = 'disrupted';
    else if (counts.total > 0) systemStatus = 'service_changes';

    return {
      timestamp: Date.now(),
      timezone: 'America/New_York',
      filteredLine: params.line || null,
      filteredLocation: params.location || null,
      filteredSeverity: params.severity || null,
      systemStatus,
      counts,
      disruptions,
      serviceNote: serviceContext.serviceNote || null
    };
  }

  private static async toDisruption(alert: SubwayAlert): Promise<DisruptionInfo> {
    const names = await Promise.all(alert.affectedStopIds.map(id => this.stationMapper.getStationName(id)));

    return {
      lines: alert.affectedLines,
      severity: alert.severity,
      category: alert.category,
      alertType: alert.alertType,
      title: alert.header || 'Service Alert',
      description: alert.description,
      affectedStations: [...new Set(names)],
      activeUntil: alert.activePeriod?.end ?? null
    };
  }
}
