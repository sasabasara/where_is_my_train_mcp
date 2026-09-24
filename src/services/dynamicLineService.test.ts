import { describe, it, expect, vi } from 'vitest';

vi.mock('./mtaService.js', () => ({ fetchMTAData: vi.fn() }));
vi.mock('./gtfsLineResolver.js', () => ({ getLinesByStationName: vi.fn(), ensureStationLineDataLoaded: vi.fn() }));

const { DynamicLineService } = await import('./dynamicLineService.js');

describe('DynamicLineService.getServiceContext (New York time, regardless of server TZ)', () => {
  it('8:22pm ET Wednesday is evening, not late night', () => {
    const ctx = DynamicLineService.getServiceContext(new Date('2026-09-24T00:22:00Z'));
    expect(ctx).toMatchObject({ timeOfDay: 'evening', isWeekend: false, serviceNote: '' });
  });

  it('1am ET Thursday is late night', () => {
    const ctx = DynamicLineService.getServiceContext(new Date('2026-09-24T05:00:00Z'));
    expect(ctx.timeOfDay).toBe('late_night');
    expect(ctx.serviceNote).toMatch(/Late night/);
  });

  it('Friday 9pm ET is not the weekend yet (Saturday in UTC)', () => {
    const ctx = DynamicLineService.getServiceContext(new Date('2026-09-26T01:00:00Z'));
    expect(ctx.isWeekend).toBe(false);
  });
});
