export interface StandardResponse<T = any> {
  status: "success" | "error";
  data: T;
  message: string;
  metadata?: {
    timestamp: number;
    source?: string;
  };
}

export interface ToolResponse {
  content: Array<{
    type: "text";
    text: string;
  }>;
  isError?: boolean;
}

export interface StationMatch {
  stop_id: string;
  stop_name: string;
  score: number;
  matchType: 'exact' | 'normalized' | 'partial_word' | 'partial_starts' | 'partial_contains';
  location_type: string;
  parent_station: string;
  stop_lat: string;
  stop_lon: string;
}

export interface StationGroup {
  name: string;
  stopIds: string[];
  score: number;
  matchType: StationMatch['matchType'];
}

export interface StationInfo {
  stopId: string;
  complexId: string;
  name: string;
  borough: string;
  /** Daytime routes as the MTA labels them: "1", "A", "S" (shuttles), "SIR" */
  routes: string[];
  northLabel: string;
  southLabel: string;
  accessibility: 'full' | 'partial' | 'none';
  accessibilityNotes: string | null;
  lat: number;
  lon: number;
}

export interface FindStationArgs {
  query: string;
}

export interface NextTrainsArgs {
  station?: string;
  stop_id?: string;
  direction?: string;
  limit?: number;
  line?: string;
}

export interface ServiceStatusArgs {
  line?: string;
}

export type AlertSeverity = 'CRITICAL' | 'MAJOR' | 'MINOR' | 'PLANNED';
export type AlertCategory = 'DELAYS' | 'SUSPENSIONS' | 'REROUTES' | 'PLANNED_WORK' | 'STATION_NOTICES' | 'OTHER';

export interface SubwayAlert {
  id: string;
  header: string;
  description: string | null;
  alertType: string | null;
  priority: number;
  severity: AlertSeverity;
  category: AlertCategory;
  affectedLines: string[];
  affectedStopIds: string[];
  isActive: boolean;
  activePeriod: { start: number; end: number | null } | null;
  updatedAt: number | null;
}

export interface SubwayAlertsArgs {
  line?: string;
  active_only?: boolean;
  category?: 'ALL' | AlertCategory;
  severity?: 'ALL' | AlertSeverity;
}

export interface StationTransfersArgs {
  station: string;
}

export interface NearestStationArgs {
  lat?: number;
  lon?: number;
  limit?: number;
  radius?: number;
  accessible_only?: boolean;
  service_filter?: string[];
}

export interface ServiceDisruptionsArgs {
  line?: string;
  location?: string;
  severity?: 'ALL' | AlertSeverity;
}

export interface EquipmentOutage {
  station: string;
  borough: string;
  trainno: string;
  equipment: string;
  equipmenttype: 'EL' | 'ES';
  serving: string;
  ADA: 'Y' | 'N';
  outagedate: string;
  estimatedreturntoservice: string;
  reason: string;
  isupcomingoutage: 'Y' | 'N';
  ismaintenanceoutage: 'Y' | 'N';
}

export interface ElevatorEscalatorStatusArgs {
  station?: string;
  equipment_type?: 'elevator' | 'escalator' | 'all';
  ada_only?: boolean;
  outage_type?: 'current' | 'upcoming' | 'all';
}
