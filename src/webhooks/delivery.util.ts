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

/** Delivery runs in WAT, in order. */
export const DELIVERY_RUN_HOURS = [9, 12, 15, 18] as const;

/** One specific run a customer can choose (e.g. 3 pm on Sat 29 Nov). */
export interface DeliveryRun {
  /** The exact moment of the run (stored on the order as deliveryAt). */
  at: Date;
  /** e.g. "3 pm" */
  time: string;
  day: 'today' | 'tomorrow';
  /** e.g. "3 pm today" */
  label: string;
  /** e.g. "Sat 29 Nov" */
  dateLabel: string;
}

function hourLabel(hour: number): string {
  if (hour === 12) return '12 pm';
  return hour > 12 ? `${hour - 12} pm` : `${hour} am`;
}

function labelToHour(label: string): number {
  return DELIVERY_RUN_HOURS.find((h) => hourLabel(h) === label) ?? 9;
}

/** Today's date in WAT as [year, monthIndex, day]. */
function watToday(now: Date): [number, number, number] {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .split('-')
    .map(Number);
  return [y, m - 1, d];
}

/** "Sat 29 Nov" for a run moment. */
export function formatRunDate(at: Date): string {
  return at.toLocaleDateString('en-GB', {
    timeZone: 'Africa/Lagos',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/** "Sat 29 Nov, 3 pm" for a run moment. */
export function formatRun(at: Date): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Lagos',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(at),
  );
  return `${formatRunDate(at)}, ${hourLabel(hour)}`;
}

/**
 * Every run a customer may pick right now: from the earliest run allowed by
 * the cutoffs (getDeliveryWindow) through the rest of today and all of
 * tomorrow. The first entry is the earliest, used when nothing is picked.
 */
export function getDeliveryRuns(now = new Date()): DeliveryRun[] {
  const earliest = getDeliveryWindow(now);
  const earliestHour = labelToHour(earliest.window);
  const [y, m, d] = watToday(now);
  const runs: DeliveryRun[] = [];

  (['today', 'tomorrow'] as const).forEach((day, offset) => {
    if (earliest.day === 'tomorrow' && day === 'today') return;
    for (const hour of DELIVERY_RUN_HOURS) {
      if (day === earliest.day && hour < earliestHour) continue;
      // WAT is UTC+1 all year.
      const at = new Date(Date.UTC(y, m, d + offset, hour - 1));
      runs.push({
        at,
        time: hourLabel(hour),
        day,
        label: `${hourLabel(hour)} ${day}`,
        dateLabel: formatRunDate(at),
      });
    }
  });

  return runs;
}

/**
 * The run for `requested` if it can still be picked; otherwise (nothing
 * requested, unparseable, or past a cutoff) the earliest run.
 */
export function resolveDeliveryRun(
  requested?: Date | string | null,
  now = new Date(),
): { run: DeliveryRun; honoured: boolean } {
  const runs = getDeliveryRuns(now);
  const wanted = requested ? new Date(requested).getTime() : NaN;
  const match = runs.find((r) => r.at.getTime() === wanted);
  return { run: match ?? runs[0], honoured: !!match };
}
