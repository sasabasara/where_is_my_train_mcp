import { describe, it, expect, vi } from 'vitest';

vi.mock('./mtaService.js', () => ({ fetchMTAAlerts: vi.fn() }));
const { mergeSplitAlerts } = await import('./alertService.js');

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
