import { describe, it, expect, vi } from 'vitest';

vi.mock('./mtaService.js', () => ({ fetchMTAAlerts: vi.fn() }));
const { mergeSplitAlerts, parseAlert, showIcons } = await import('./alertService.js');

describe('alert text', () => {
  it('shows MTA icon placeholders as words, keeping line bullets', () => {
    expect(showIcons('59 St-Columbus Circle [accessibility icon] | [A][D][1]')).toBe('59 St-Columbus Circle (accessible) | [A][D][1]');
    expect(showIcons('Free [shuttle bus icon] T464 buses')).toBe('Free (shuttle bus) T464 buses');
    const alert = parseAlert({ id: 'x', alert: { header_text: { translation: [{ language: 'en', text: 'Use [accessibility icon] stations' }] } } });
    expect(alert?.header).toBe('Use (accessible) stations');
  });
});

describe('alert timing', () => {
  it('shows an alert with no active_period for as long as it is present in the feed', () => {
    expect(parseAlert({ id: 'always', alert: { header_text: { translation: [{ text: 'Service suspended' }] } } })?.isActive).toBe(true);
  });

  it('ends an alert exactly at the end of its time range', () => {
    expect(parseAlert({ id: 'ended', alert: { active_period: [{ start: 1, end: 2 }] } }, 2000)?.isActive).toBe(false);
  });
});

const alert = (id: string, priority: number, lines: string[], severity: any) => ({
  id, header: 'No [2] between Franklin Av and Flatbush Av', description: null, alertType: null,
  priority, severity, category: 'OTHER' as const, affectedLines: lines, affectedStopIds: [],
  isActive: true, activePeriod: null, updatedAt: null
});

describe('mergeSplitAlerts', () => {
  it('merges one incident split per priority into a single alert at its highest severity', () => {
    const merged = mergeSplitAlerts([
      alert('lmm:alert:268751:26', 26, ['5'], 'MAJOR'),
      alert('lmm:alert:268751:34', 34, ['2'], 'CRITICAL')
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'lmm:alert:268751', severity: 'CRITICAL', affectedLines: ['2', '5'] });
  });

  it('does not merge separate planned-work notices', () => {
    const merged = mergeSplitAlerts([
      alert('lmm:planned_work:35011', 16, ['7'], 'PLANNED'),
      alert('lmm:planned_work:35016', 21, ['H'], 'PLANNED')
    ]);
    expect(merged).toHaveLength(2);
  });
});
