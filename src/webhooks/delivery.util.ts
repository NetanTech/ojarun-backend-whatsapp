export interface DeliveryWindow {
  window: string;
  day: 'today' | 'tomorrow';
}

export function getDeliveryWindow(now = new Date()): DeliveryWindow {
  // Always calculate in WAT (Africa/Lagos = UTC+1)
  const wat = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
  const mins = wat.getHours() * 60 + wat.getMinutes();

  // before 8:00 AM
  if (mins < 480) return { window: '9:00 AM – 10:00 AM', day: 'today' };
  // 8:01 AM – 12:00 PM
  if (mins <= 720) return { window: '1:00 PM – 2:00 PM', day: 'today' };
  // 12:01 PM – 4:00 PM
  if (mins <= 960) return { window: '5:00 PM – 6:00 PM', day: 'today' };
  // after 4:01 PM
  return { window: '9:00 AM – 10:00 AM', day: 'tomorrow' };
}