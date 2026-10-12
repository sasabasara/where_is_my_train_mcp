import { getServiceContext } from '../utils/time.js';
import { getStopName, StationMatcher } from './stationService.js';
import { riderLines } from './stationInfoService.js';
import { nycIso } from '../utils/time.js';
import type { AlertCategory, AlertSeverity, ServiceDisruptionsArgs, SubwayAlert } from '../types/index.js';

export interface DisruptionInfo {
  lines: string[];
  severity: AlertSeverity;
  category: AlertCategory;
  alertType: string | null;
  title: string;
  description: string | null;
  affectedStations: string[];
  activeUntil: string | null;
}

// The system-wide overview lists every disruption; full planned-work text for all of them
// runs to thousands of tokens. A line or location query gets the full text.
const OVERVIEW_DESCRIPTION_CHARS = 300;

function shorten(text: string | null): string | null {
  if (!text || text.length <= OVERVIEW_DESCRIPTION_CHARS) return text;
  const cut = text.slice(0, OVERVIEW_DESCRIPTION_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export class ServiceDisruptionAnalyzer {
  /**
   * @param alerts Currently active alerts, already filtered by line/severity and sorted most severe first
   */
  static analyze(params: ServiceDisruptionsArgs, alerts: SubwayAlert[]) {
    const serviceContext = getServiceContext();
    let disruptions = alerts.map(alert => this.toDisruption(alert));

    if (params.location) {
      // Normalized like station names and matched at a word start, so "union square" and
      // "14th street" match "14 St-Union Sq" (but "14th street" doesn't match "114 St")
      const q = ` ${StationMatcher.normalizeStationName(params.location)}`;
      const mentions = (text: string | null) => ` ${StationMatcher.normalizeStationName(text ?? '')}`.includes(q);
      disruptions = disruptions.filter(d =>
        d.affectedStations.some(mentions) || mentions(d.title) || mentions(d.description)
      );
    }

    const descriptionsShortened = !params.line && !params.location &&
      disruptions.some(d => (d.description?.length ?? 0) > OVERVIEW_DESCRIPTION_CHARS);
    if (descriptionsShortened) {
      disruptions = disruptions.map(d => ({ ...d, description: shorten(d.description) }));
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
      descriptionsShortened,
      serviceNote: serviceContext.serviceNote || null
    };
  }

  private static toDisruption(alert: SubwayAlert): DisruptionInfo {
    const names = alert.affectedStopIds.map(getStopName);

    return {
      lines: riderLines(alert.affectedLines),
      severity: alert.severity,
      category: alert.category,
      alertType: alert.alertType,
      title: alert.header || 'Service Alert',
      description: alert.description,
      affectedStations: [...new Set(names)],
      activeUntil: alert.activePeriod?.end ? nycIso(alert.activePeriod.end) : null
    };
  }
}
