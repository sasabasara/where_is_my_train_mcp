/**
 * Hour and weekday in New York — the server runs in UTC on Railway,
 * so Date#getHours()/getDay() would be 4-5 hours off.
 */
export function nycTime(now = new Date()): { hour: number; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hourCycle: 'h23',
    weekday: 'short'
  }).formatToParts(now);
  return {
    hour: Number(parts.find(p => p.type === 'hour')?.value),
    weekday: parts.find(p => p.type === 'weekday')?.value ?? ''
  };
}

/**
 * Get service context (weekday/weekend, time of day)
 * Late night hours based on official MTA definition: midnight to 6:00 AM
 */
export function getServiceContext(now = new Date()): { isWeekend: boolean; timeOfDay: string; serviceNote: string } {
  const { hour, weekday } = nycTime(now);
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';

  let timeOfDay = 'daytime';
  if (hour >= 0 && hour < 6) timeOfDay = 'late_night'; // MTA official: midnight to 6:00 AM
  else if (hour >= 6 && hour < 10) timeOfDay = 'morning_rush';
  else if (hour >= 10 && hour < 16) timeOfDay = 'midday';
  else if (hour >= 16 && hour < 20) timeOfDay = 'evening_rush';
  else if (hour >= 20) timeOfDay = 'evening';

  let serviceNote = '';
  if (isWeekend) {
    serviceNote = '🗓️ Weekend service - some lines may have modified routes or reduced frequency';
  } else if (timeOfDay === 'late_night') {
    serviceNote = '🌙 Late night service (midnight-6AM) - limited trains and modified routes';
  }

  return { isWeekend, timeOfDay, serviceNote };
}

const NYC_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23', timeZoneName: 'longOffset'
});

/** New York local time with its UTC offset, e.g. 1791765220000 → "2026-10-11T20:33:40-04:00". */
export function nycIso(ms: number): string {
  const p = Object.fromEntries(NYC_PARTS.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  const offset = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName.replace('GMT', '');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}

/** Offset of New York from UTC at an instant, in ms (e.g. -4h in summer). */
function nycOffsetMs(ms: number): number {
  const [, sign, h, m] = nycIso(ms).match(/([+-])(\d{2}):(\d{2})$/)!;
  return (sign === '-' ? -1 : 1) * (Number(h) * 60 + Number(m)) * 60000;
}

/**
 * The MTA's New York local time strings ("10/03/2026 07:20:00 PM", elevator feed) in the same
 * ISO form as nycIso. Returns null for anything else.
 */
export function mtaLocalTimeToIso(text: string | null | undefined): string | null {
  const m = text?.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))? ?(AM|PM)$/i);
  if (!m) return null;
  const [, month, day, year, hour12, minute, second = '0', ampm] = m;
  const hour = (Number(hour12) % 12) + (ampm.toUpperCase() === 'PM' ? 12 : 0);
  const asUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), hour, Number(minute), Number(second));
  // Shift by New York's offset, re-checking it at the result in case DST changes in between
  const guess = asUtc - nycOffsetMs(asUtc);
  return nycIso(asUtc - nycOffsetMs(guess));
}
