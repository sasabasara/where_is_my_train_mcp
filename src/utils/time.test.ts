import { describe, it, expect } from 'vitest';
import { getServiceContext } from './time.js';

describe('getServiceContext (New York time, regardless of server TZ)', () => {
  it('8:22pm ET Wednesday is evening, not late night', () => {
    const ctx = getServiceContext(new Date('2026-09-24T00:22:00Z'));
    expect(ctx).toMatchObject({ timeOfDay: 'evening', isWeekend: false, serviceNote: '' });
  });

  it('1am ET Thursday is late night', () => {
    const ctx = getServiceContext(new Date('2026-09-24T05:00:00Z'));
    expect(ctx.timeOfDay).toBe('late_night');
    expect(ctx.serviceNote).toMatch(/Late night/);
  });

  it('Friday 9pm ET is not the weekend yet (Saturday in UTC)', () => {
    const ctx = getServiceContext(new Date('2026-09-26T01:00:00Z'));
    expect(ctx.isWeekend).toBe(false);
  });
});
