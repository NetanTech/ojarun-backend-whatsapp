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

/** Customer asking about same-day / evening / morning delivery timing. */
export function looksLikeDeliveryTimingQuestion(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/\n/g, ' ');
  if (!t) return false;
  const asksWhen =
    /\b(this\s+evening|this\s+afternoon|tonight|same\s*day|can i get it (today|this evening|tonight)|deliver(y|ed)?\s*(today|this evening|tonight)|get it (today|this evening|tonight))\b/i.test(
      t,
    );
  const mentionsDelivery =
    /\b(deliver|delivery|get it|bring|come|evening|afternoon|tonight|today)\b/i.test(
      t,
    );
  return asksWhen && mentionsDelivery;
}

/**
 * Plain-language answer for "can I get it this evening?" based on current WAT.
 */
export function explainDeliveryTiming(now = new Date()): string {
  const { window, day } = getDeliveryWindow(now);
  const wat = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
  const hour = wat.getHours();

  if (day === 'tomorrow') {
    return (
      `Same-day evening delivery is closed for today (cutoff is around 4pm WAT).\n\n` +
      `Next window is *${window} tomorrow*.\n\n` +
      `Send your full list + area/landmark and we'll shop for that slot.`
    );
  }

  if (hour >= 12) {
    return (
      `Yes — if you confirm soon, we can aim for *${window} today*.\n\n` +
      `Send everything in one message (items + quantities) and your area/landmark.`
    );
  }

  return (
    `Yes — orders in now go out *${window} today*.\n\n` +
    `Send your full list in one message and your area/landmark.`
  );
}
