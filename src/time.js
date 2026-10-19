// Turns what a user types ("yesterday 6pm", "2h ago", a message link, ...)
// into an exact moment, always interpreted in India Standard Time.
import * as chrono from 'chrono-node';

export const TIMEZONE = 'Asia/Kolkata';
const IST_OFFSET_MINUTES = 330; // UTC+05:30
const DAY_MS = 24 * 60 * 60 * 1000;

// ---- Discord snowflake helpers -------------------------------------------
// Every message ID encodes the moment it was sent, so we can convert both ways
// without any API calls.
const DISCORD_EPOCH = 1420070400000n;

export function snowflakeToMs(id) {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

/** Smallest possible snowflake for a given millisecond. */
export function msToSnowflake(ms) {
  const clamped = BigInt(Math.max(Math.floor(ms), Number(DISCORD_EPOCH)));
  return ((clamped - DISCORD_EPOCH) << 22n).toString();
}

// ---- Parsing ---------------------------------------------------------------
const MESSAGE_LINK = /discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d+)\/(\d+)/i;
const DISCORD_TIMESTAMP = /^<t:(-?\d+)(?::[tTdDfFsSR])?>$/;
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * @param {string} input   what the user typed
 * @param {object} [opts]
 * @param {Date}   [opts.now]
 * @param {boolean}[opts.preferPast] when a bare time like "6pm" lands in the
 *        future, assume the user meant the most recent 6pm (i.e. yesterday).
 * @returns {null | {ms:number, kind:'now'|'timestamp'|'message'|'text',
 *          messageId?:string, channelId?:string, matched?:string}}
 */
export function parseWhen(input, { now = new Date(), preferPast = false } = {}) {
  const text = String(input ?? '').trim();
  if (!text) return null;

  if (/^(now|right now|present)$/i.test(text)) {
    return { ms: now.getTime(), kind: 'now' };
  }

  const ts = text.match(DISCORD_TIMESTAMP);
  if (ts) return { ms: Number(ts[1]) * 1000, kind: 'timestamp' };
  if (/^\d{13}$/.test(text)) return { ms: Number(text), kind: 'timestamp' };
  if (/^\d{10}$/.test(text)) return { ms: Number(text) * 1000, kind: 'timestamp' };

  const link = text.match(MESSAGE_LINK);
  if (link) {
    return { ms: snowflakeToMs(link[2]), kind: 'message', channelId: link[1], messageId: link[2] };
  }
  if (SNOWFLAKE.test(text)) {
    return { ms: snowflakeToMs(text), kind: 'message', messageId: text };
  }

  // en.GB reads "18/10" as 18 October (day first), as used in India.
  const results = chrono.en.GB.parse(
    text,
    { instant: now, timezone: IST_OFFSET_MINUTES },
    { forwardDate: false },
  );
  if (!results.length) return null;

  const start = results[0].start;
  let ms = start.date().getTime();

  const dayWasGiven =
    start.isCertain('day') || start.isCertain('weekday') || start.isCertain('month');
  if (preferPast && !dayWasGiven && ms > now.getTime()) {
    ms -= DAY_MS;
  }

  return { ms, kind: 'text', matched: results[0].text };
}

// ---- Formatting ------------------------------------------------------------
const longFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: TIMEZONE,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const shortFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: TIMEZONE,
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** "Mon, 19 Oct 2026, 2:05 pm IST" — used in autocomplete previews. */
export function formatLong(ms) {
  return `${longFmt.format(new Date(ms))} IST`;
}

/** "19 Oct, 14:05" — compact, used in the transcript sent to the AI. */
export function formatShort(ms) {
  return shortFmt.format(new Date(ms));
}

/** Discord's own timestamp markup: renders nicely for every viewer. */
export function discordTime(ms, style = 'f') {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/** "3h 20m" */
export function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(totalMinutes / 1440);
  const h = Math.floor((totalMinutes % 1440) / 60);
  const m = totalMinutes % 60;
  return [d && `${d}d`, h && `${h}h`, (m || (!d && !h)) && `${m}m`].filter(Boolean).join(' ');
}
