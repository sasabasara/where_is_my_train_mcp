export interface Stop {
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  location_type: string;
  parent_station: string;
}

export interface Transfer {
  from_stop_id: string;
  to_stop_id: string;
  transfer_type: string;
  min_transfer_time?: string;
}

export interface Route {
  route_id: string;
  route_short_name: string;
  route_long_name: string;
  route_type: string;
  route_color: string;
}

export interface TripDescriptor {
  tripId?: string;
  routeId?: string;
  directionId?: number;
  startTime?: string;
  startDate?: string;
  scheduleRelationship?: string;
}

export interface VehicleDescriptor {
  id?: string;
  label?: string;
  licensePlate?: string;
}

export interface StopTimeUpdate {
  stopSequence?: number;
  stopId?: string;
  arrival?: {
    delay?: number;
    time?: string;
    uncertainty?: number;
  };
  departure?: {
    delay?: number;
    time?: string;
    uncertainty?: number;
  };
  scheduleRelationship?: string;
  departureOccupancyStatus?: string;
}

export interface TripUpdate {
  trip: TripDescriptor;
  vehicle?: VehicleDescriptor;
  stopTimeUpdate?: StopTimeUpdate[];
  timestamp?: string;
  delay?: number;
}

export interface VehiclePosition {
  trip?: TripDescriptor;
  vehicle?: VehicleDescriptor;
  position?: {
    latitude: number;
    longitude: number;
    bearing?: number;
    odometer?: number;
    speed?: number;
  };
  currentStopSequence?: number;
  stopId?: string;
  currentStatus?: string;
  timestamp?: string;
  congestionLevel?: string;
  occupancyStatus?: string;
  occupancyPercentage?: number;
}

export interface TimeRange {
  start?: string;
  end?: string;
}

export interface EntitySelector {
  agencyId?: string;
  routeId?: string;
  routeType?: number;
  trip?: TripDescriptor;
  stopId?: string;
}

export interface TranslatedString {
  translation: Array<{
    text: string;
    language?: string;
  }>;
}

export interface Alert {
  activePeriod?: TimeRange[];
  informedEntity?: EntitySelector[];
  cause?: string;
  effect?: string;
  url?: TranslatedString;
  headerText?: TranslatedString;
  descriptionText?: TranslatedString;
}

export interface FeedHeader {
  gtfsRealtimeVersion: string;
  incrementality?: string;
  timestamp?: string;
}

export interface GTFSEntity {
  id: string;
  isDeleted?: boolean;
  tripUpdate?: TripUpdate;
  vehicle?: VehiclePosition;
  alert?: Alert;
}

export interface MTAFeedData {
  entity: GTFSEntity[];
  header: FeedHeader;
  feedStatus: {
    successful: number;
    failed: number;
    failedFeeds: string[];
  };
}

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

export interface FindStationArgs {
  query: string;
}

export interface NextTrainsArgs {
  station: string;
  direction?: 'uptown' | 'downtown' | 'manhattan' | 'brooklyn' | 'queens' | 'bronx';
  limit?: number;
  line?: string;
}

export interface ServiceStatusArgs {
  line?: string;
  include_metrics?: boolean;
  time_range?: 'current' | 'today' | 'week';
}

export interface SubwayAlertsArgs {
  line?: string;
  active_only?: boolean;
  category?: 'ALL' | 'DELAYS' | 'SUSPENSIONS' | 'REROUTES' | 'PLANNED_WORK' | 'ACCESSIBILITY';
  severity?: 'ALL' | 'CRITICAL' | 'MAJOR' | 'MINOR' | 'PLANNED';
}

export interface StationTransfersArgs {
  station: string;
}

export interface NearestStationArgs {
  location?: string;
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
  severity?: 'ALL' | 'CRITICAL' | 'MAJOR' | 'MINOR';
}

export interface CacheStatus {
  cached: boolean;
  age: number | null;
  nextUpdate: string | null;
  stale?: boolean;
}

export interface GTFSSourceInfo {
  source: string;
  status: {
    regular: CacheStatus;
    supplemented: CacheStatus;
  };
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
