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
