// Pulls every message in a channel between two message-ID bounds and turns
// them into a plain-text transcript the AI can read.
import { formatShort } from './time.js';

/**
 * Fetch messages with  afterId < id < beforeId  (exclusive on both ends),
 * walking backwards from the end, 100 at a time.
 *
 * @returns {{ messages: import('discord.js').Message[], truncated: boolean }}
 *          messages are oldest → newest. If more than `max` exist, the most
 *          recent `max` are kept and `truncated` is true.
 */
export async function fetchRange(channel, { afterId, beforeId, max }) {
  const after = BigInt(afterId);
  let before = beforeId;
  const collected = [];
  let truncated = false;

  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, before, cache: false });
    if (batch.size === 0) break;

    let oldest = null;
    for (const msg of batch.values()) {
      const id = BigInt(msg.id);
      if (oldest === null || id < oldest) oldest = id;
      if (id > after) collected.push(msg);
    }

    if (collected.length >= max) {
      truncated = true;
      break;
    }
    if (oldest <= after || batch.size < 100) break;
    before = oldest.toString();
  }

  collected.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const messages = truncated ? collected.slice(-max) : collected;
  return { messages, truncated };
}

function displayName(user) {
  return user?.globalName || user?.username || 'Unknown';
}

/** One line per message: "[19 Oct, 14:05] Rahul (replying to Priya): text" */
export function toTranscript(messages, { botId } = {}) {
  const lines = [];
  for (const msg of messages) {
    if (msg.system) continue; // joins, pins, boosts...
    if (botId && msg.author?.id === botId) continue; // our own earlier summaries

    const parts = [];
    const content = (msg.cleanContent || msg.content || '').trim();
    if (content) parts.push(content);
    for (const a of msg.attachments.values()) parts.push(`[attachment: ${a.name}]`);
    for (const s of msg.stickers.values()) parts.push(`[sticker: ${s.name}]`);
    for (const e of msg.embeds) {
      const label = e.title || e.description?.slice(0, 120);
      if (label) parts.push(`[embed: ${label}]`);
    }
    if (msg.poll) parts.push(`[poll: ${msg.poll.question?.text ?? ''}]`);
    if (!parts.length) continue;

    const replyTo = msg.reference?.messageId ? msg.mentions?.repliedUser : null;
    const who =
      displayName(msg.author) +
      (msg.author?.bot ? ' [bot]' : '') +
      (replyTo ? ` (replying to ${displayName(replyTo)})` : '');

    const body = parts.join(' ').replace(/\s*\n\s*/g, ' / ');
    lines.push(`[${formatShort(msg.createdTimestamp)}] ${who}: ${body}`);
  }
  return lines;
}
