import { fetchMTAAlerts } from './mtaService.js';
import { routeMatchesLine } from './stationInfoService.js';
import type { AlertSeverity, AlertCategory, SubwayAlert } from '../types/index.js';

// MTA Mercury priorities (gtfs-realtime-service-status.proto, MercuryEntitySelector.Priority).
// The feed encodes them as the last segment of sort_order, e.g. "MTASBWY:6:26" = PRIORITY_DELAYS.
// Higher numbers are more severe. Severity/category buckets below are our grouping of those values.
const SEVERITY_BY_PRIORITY: Record<number, AlertSeverity> = {
  30: 'CRITICAL', // severe delays
  33: 'CRITICAL', // substitute buses
  34: 'CRITICAL', // part suspended
  35: 'CRITICAL', // suspended
  13: 'MAJOR',    // reduced service
  26: 'MAJOR',    // delays
  27: 'MAJOR',    // cancellations
  28: 'MAJOR',    // delays and cancellations
  29: 'MAJOR',    // stops skipped
  31: 'MAJOR',    // detour
  32: 'MAJOR',    // reroute
  1: 'PLANNED',   // no scheduled service
  14: 'PLANNED', 15: 'PLANNED', 16: 'PLANNED', 17: 'PLANNED',
  18: 'PLANNED', 19: 'PLANNED', 20: 'PLANNED', 21: 'PLANNED', 23: 'PLANNED'
};

const CATEGORY_BY_PRIORITY: Record<number, AlertCategory> = {
  12: 'DELAYS', 13: 'DELAYS', 24: 'DELAYS', 26: 'DELAYS', 27: 'DELAYS', 28: 'DELAYS', 30: 'DELAYS',
  33: 'SUSPENSIONS', 34: 'SUSPENSIONS', 35: 'SUSPENSIONS',
  22: 'REROUTES', 25: 'REROUTES', 29: 'REROUTES', 31: 'REROUTES', 32: 'REROUTES',
  1: 'PLANNED_WORK', 14: 'PLANNED_WORK', 15: 'PLANNED_WORK', 16: 'PLANNED_WORK', 17: 'PLANNED_WORK',
  18: 'PLANNED_WORK', 19: 'PLANNED_WORK', 20: 'PLANNED_WORK', 21: 'PLANNED_WORK', 23: 'PLANNED_WORK',
  3: 'STATION_NOTICES', 10: 'STATION_NOTICES'
};

function englishText(translated: any): string {
  const translations: any[] = translated?.translation ?? [];
  const en = translations.find(t => t.language === 'en') ?? translations[0];
  return en?.text ?? '';
}

function priorityOf(sortOrder: unknown): number {
  if (typeof sortOrder !== 'string') return 0;
  const n = Number(sortOrder.split(':').pop());
  return Number.isFinite(n) ? n : 0;
}

export function parseAlert(entity: any, now = Date.now()): SubwayAlert | null {
  const alert = entity?.alert;
  if (!alert) return null;

  const informed: any[] = alert.informed_entity ?? [];
  const mercury = alert['transit_realtime.mercury_alert'] ?? {};
  const priority = Math.max(0, ...informed.map(ie => priorityOf(ie['transit_realtime.mercury_entity_selector']?.sort_order)));

  const periods = (alert.active_period ?? []).map((p: any) => ({
    start: p.start ? Number(p.start) * 1000 : 0,
    end: p.end ? Number(p.end) * 1000 : null
  }));
  const current = periods.find((p: any) => p.start <= now && (p.end === null || p.end >= now));
  const next = periods
    .filter((p: any) => p.start > now)
    .sort((a: any, b: any) => a.start - b.start)[0];

  return {
    id: entity.id,
    header: englishText(alert.header_text),
    description: englishText(alert.description_text) || null,
    alertType: mercury.alert_type ?? null,
    priority,
    severity: SEVERITY_BY_PRIORITY[priority] ?? 'MINOR',
    category: CATEGORY_BY_PRIORITY[priority] ?? 'OTHER',
    affectedLines: [...new Set(informed.map(ie => ie.route_id).filter(Boolean))] as string[],
    affectedStopIds: [...new Set(informed.map(ie => ie.stop_id).filter(Boolean))] as string[],
    isActive: Boolean(current),
    activePeriod: current ?? next ?? null,
    updatedAt: mercury.updated_at ? Number(mercury.updated_at) * 1000 : null
  };
}

export interface AlertFilters {
  line?: string;
  activeOnly?: boolean;
  severity?: AlertSeverity | 'ALL';
  category?: AlertCategory | 'ALL';
}

/**
 * The MTA splits one incident into one entity per priority, e.g. "lmm:alert:268751:34"
 * (2 train, Part Suspended) and "lmm:alert:268751:26" (5 train, Delays), same text.
 * Merge them so riders see one alert covering all its lines, at its highest severity.
 */
export function mergeSplitAlerts(alerts: SubwayAlert[]): SubwayAlert[] {
  const merged = new Map<string, SubwayAlert>();
  for (const alert of alerts) {
    const key = alert.id.match(/^(lmm:alert:\d+):\d+$/)?.[1] ?? alert.id;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...alert, id: key });
      continue;
    }
    const [primary, secondary] = alert.priority > existing.priority ? [alert, existing] : [existing, alert];
    merged.set(key, {
      ...primary,
      id: key,
      affectedLines: [...new Set([...primary.affectedLines, ...secondary.affectedLines])],
      affectedStopIds: [...new Set([...primary.affectedStopIds, ...secondary.affectedStopIds])],
      isActive: primary.isActive || secondary.isActive
    });
  }
  return [...merged.values()];
}

/**
 * Parsed subway alerts, most severe first (by MTA priority, then most recently updated).
 */
export async function getSubwayAlerts(filters: AlertFilters = {}): Promise<SubwayAlert[]> {
  const feed = await fetchMTAAlerts();
  const now = Date.now();
  const line = filters.line?.trim();

  const parsed = feed.entity
    .map((e: any) => parseAlert(e, now))
    .filter((a: SubwayAlert | null): a is SubwayAlert => a !== null);

  return mergeSplitAlerts(parsed)
    .filter((a: SubwayAlert) => !filters.activeOnly || a.isActive)
    .filter((a: SubwayAlert) => !line || a.affectedLines.some(route => routeMatchesLine(route, line)))
    .filter((a: SubwayAlert) => !filters.severity || filters.severity === 'ALL' || a.severity === filters.severity)
    .filter((a: SubwayAlert) => !filters.category || filters.category === 'ALL' || a.category === filters.category)
    .sort((a: SubwayAlert, b: SubwayAlert) => b.priority - a.priority || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
