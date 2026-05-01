import { DynamicLineService } from './dynamicLineService.js';
import { StationMapper } from './stationMapper.js';

export interface DisruptionInfo {
  line: string;
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR' | 'PLANNED';
  category: 'DELAYS' | 'SUSPENSIONS' | 'REROUTES' | 'PLANNED_WORK' | 'ACCESSIBILITY';
  title: string;
  description: string;
  affectedStations: string[];
  estimatedResolution?: string;
  alternativeRoutes: string[];
  impact: 'system_wide' | 'line_wide' | 'local';
}

export class ServiceDisruptionAnalyzer {
  private static stationMapper = new StationMapper();

  static async analyze(params: any, alertsData: any, statusData: any): Promise<any> {
    const serviceContext = DynamicLineService.getServiceContext();
    const disruptions = await this.analyzeDisruptions(alertsData, statusData, params);
    return this.formatDisruptionResponse(disruptions, serviceContext, params);
  }

  private static async analyzeDisruptions(alertsData: any, statusData: any, params: any): Promise<DisruptionInfo[]> {
    const alerts = alertsData.entity?.filter((entity: any) => entity.alert) || [];
    const analyzedDisruptions: DisruptionInfo[] = [];

    for (const entity of alerts) {
      const alert = entity.alert;
      if (!alert) continue;

      // Extract affected lines
      const affectedLines = alert.informedEntity?.map((ie: any) => ie.routeId).filter(Boolean) || [];
      
      // Extract affected stations and convert to human-readable names
      const affectedStopIds = alert.informedEntity?.map((ie: any) => ie.stopId).filter(Boolean) || [];
      const affectedStations: string[] = [];
      
      for (const stopId of affectedStopIds) {
        const stationName = await this.stationMapper.getStationName(stopId);
        affectedStations.push(stationName);
      }
      
      // Determine severity based on alert effect
      let severity: DisruptionInfo['severity'] = 'MINOR';
      if (alert.effect === 'NO_SERVICE') severity = 'CRITICAL';
      else if (alert.effect === 'REDUCED_SERVICE' || alert.effect === 'SIGNIFICANT_DELAYS') severity = 'MAJOR';
      else if (alert.effect === 'DETOUR' || alert.effect === 'ADDITIONAL_SERVICE') severity = 'MINOR';
      
      // Determine category based on alert content
      let category: DisruptionInfo['category'] = 'DELAYS';
      const headerText = alert.headerText?.translation?.[0]?.text?.toLowerCase() || '';
      const descText = alert.descriptionText?.translation?.[0]?.text?.toLowerCase() || '';
      const combinedText = `${headerText} ${descText}`;
      
      if (combinedText.includes('suspend') || combinedText.includes('no service')) {
        category = 'SUSPENSIONS';
      } else if (combinedText.includes('reroute') || combinedText.includes('detour')) {
        category = 'REROUTES';
      } else if (combinedText.includes('planned') || combinedText.includes('weekend') || combinedText.includes('maintenance')) {
        category = 'PLANNED_WORK';
        severity = 'PLANNED';
      } else if (combinedText.includes('elevator') || combinedText.includes('escalator') || combinedText.includes('accessible')) {
        category = 'ACCESSIBILITY';
      }

      // Determine impact scope
      let impact: DisruptionInfo['impact'] = 'local';
      if (affectedLines.length > 3) impact = 'system_wide';
      else if (affectedLines.length > 1) impact = 'line_wide';

      // Extract alternative routes from alert text only
      const alternativeRoutes = this.extractAlternativeRoutes(alert);

      // Create disruption info for each affected line
      for (const line of affectedLines) {
        analyzedDisruptions.push({
          line,
          severity,
          category,
          title: alert.headerText?.translation?.[0]?.text || 'Service Alert',
          description: alert.descriptionText?.translation?.[0]?.text || 'No details available',
          affectedStations,
          estimatedResolution: this.extractResolutionTime(alert),
          alternativeRoutes,
          impact
        });
      }
    }

    // Apply filters
    return analyzedDisruptions.filter(disruption => {
      if (params.line && disruption.line !== params.line) return false;
      if (params.severity && params.severity !== 'ALL' && disruption.severity !== params.severity) return false;
      if (params.location) {
        const locationLower = params.location.toLowerCase();
        return disruption.affectedStations.some(station => 
          station.toLowerCase().includes(locationLower)
        ) || disruption.description.toLowerCase().includes(locationLower);
      }
      return true;
    });
  }

  private static extractAlternativeRoutes(alert: any): string[] {
    const alternatives: string[] = [];
    const description = alert.descriptionText?.translation?.[0]?.text || '';
    
    // Only extract alternatives explicitly mentioned in MTA alert text
    const altRoutePatterns = [
      /use\s+([A-Z0-9,\s]+)\s+train/gi,
      /take\s+([A-Z0-9,\s]+)\s+train/gi,
      /consider\s+([A-Z0-9,\s]+)\s+train/gi,
      /transfer\s+to\s+([A-Z0-9,\s]+)/gi
    ];
    
    altRoutePatterns.forEach(pattern => {
      const matches = description.match(pattern);
      if (matches) {
        matches.forEach((match: string) => {
          const routes = match.replace(/(use|take|consider|transfer to)\s+|train/gi, '').trim();
          if (routes) {
            alternatives.push(`Use ${routes} trains`);
          }
        });
      }
    });
    
    return alternatives;
  }

  private static extractResolutionTime(alert: any): string | undefined {
    const description = alert.descriptionText?.translation?.[0]?.text || '';
    
    // Look for time patterns
    const timePatterns = [
      /until\s+(\d{1,2}:\d{2}\s*[AP]M)/i,
      /through\s+(\w+day)/i,
      /(\d{1,2}\/\d{1,2})/,
      /until\s+further\s+notice/i
    ];
    
    for (const pattern of timePatterns) {
      const match = description.match(pattern);
      if (match) {
        return match[1] || match[0];
      }
    }
    
    return undefined;
  }

  private static formatDisruptionResponse(
    disruptions: DisruptionInfo[],
    serviceContext: any,
    params: any
  ): any {
    const critical = disruptions.filter(d => d.severity === 'CRITICAL');
    const major = disruptions.filter(d => d.severity === 'MAJOR');
    const minor = disruptions.filter(d => d.severity === 'MINOR');
    const planned = disruptions.filter(d => d.severity === 'PLANNED');

    return {
      timestamp: Date.now(),
      timezone: 'America/New_York',
      filteredLine: params.line || null,
      filteredLocation: params.location || null,
      filteredSeverity: params.severity || null,
      systemStatus: disruptions.length === 0 ? 'normal' : 'disrupted',
      counts: {
        total: disruptions.length,
        critical: critical.length,
        major: major.length,
        minor: minor.length,
        planned: planned.length
      },
      disruptions,
      serviceNote: serviceContext.serviceNote || null
    };
  }
}
