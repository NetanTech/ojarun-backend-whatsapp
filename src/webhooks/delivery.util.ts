export interface DeliveryWindow {
  window: string;
  day: 'today' | 'tomorrow';
}

/** Minutes since midnight in WAT (Africa/Lagos, UTC+1, no DST). */
function watMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

/**
 * Delivery runs go out at 9 am, 12 pm, 3 pm and 6 pm WAT:
 *   7:00 am – 9:59 am  → 12 pm today
 *   10:00 am – 12:59 pm → 3 pm today
 *   1:00 pm – 3:59 pm  → 6 pm today
 *   4:00 pm – midnight → 9 am tomorrow
 *   midnight – 6:59 am → 9 am today (the "next day" run for overnight orders)
 */
export function getDeliveryWindow(now = new Date()): DeliveryWindow {
  const mins = watMinutes(now);

  if (mins < 7 * 60) return { window: '9 am', day: 'today' };
  if (mins < 10 * 60) return { window: '12 pm', day: 'today' };
  if (mins < 13 * 60) return { window: '3 pm', day: 'today' };
  if (mins < 16 * 60) return { window: '6 pm', day: 'today' };
  return { window: '9 am', day: 'tomorrow' };
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
  const hour = Math.floor(watMinutes(now) / 60);

  if (day === 'tomorrow') {
    return (
      `Same-day evening delivery is closed for today (cutoff is 4pm WAT).\n\n` +
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
