import { describe, it, expect } from 'vitest';
import { getServiceContext, nycIso, mtaLocalTimeToIso } from './time.js';

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

describe('New York ISO times', () => {
  it('formats instants in New York time with the right offset, summer and winter', () => {
    expect(nycIso(Date.UTC(2026, 9, 12, 0, 33, 40))).toBe('2026-10-11T20:33:40-04:00');
    expect(nycIso(Date.UTC(2026, 11, 1, 17, 5, 0))).toBe('2026-12-01T12:05:00-05:00');
  });

  it('converts the MTA elevator feed format, which is New York local time', () => {
    expect(mtaLocalTimeToIso('10/03/2026 07:20:00 PM')).toBe('2026-10-03T19:20:00-04:00');
    expect(mtaLocalTimeToIso('12/24/2026 12:00:00 AM')).toBe('2026-12-24T00:00:00-05:00');
    expect(mtaLocalTimeToIso('11/01/2026 12:30:00 PM')).toBe('2026-11-01T12:30:00-05:00'); // DST ended 2am that day
    expect(mtaLocalTimeToIso('')).toBeNull();
    expect(mtaLocalTimeToIso('soon')).toBeNull();
  });
});
