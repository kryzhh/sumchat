// Run with: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatDuration, formatLong, msToSnowflake, parseWhen, snowflakeToMs } from '../src/time.js';
import { chunkLines } from '../src/summarize.js';

// Mon 19 Oct 2026, 16:00 IST
const NOW = new Date('2026-10-19T16:00:00+05:30');
const ist = (s) => new Date(`${s}+05:30`).getTime();

test('snowflake <-> time round trip', () => {
  const ms = ist('2026-10-19T14:05:00');
  assert.equal(snowflakeToMs(msToSnowflake(ms)), ms);
});

test('relative times', () => {
  assert.equal(parseWhen('2 hours ago', { now: NOW }).ms, ist('2026-10-19T14:00:00'));
  assert.equal(parseWhen('now', { now: NOW }).ms, NOW.getTime());
});

test('times are read in IST', () => {
  assert.equal(parseWhen('today 9am', { now: NOW }).ms, ist('2026-10-19T09:00:00'));
  assert.equal(parseWhen('yesterday 6pm', { now: NOW }).ms, ist('2026-10-18T18:00:00'));
});

test('day-first dates (18/10 = 18 October)', () => {
  assert.equal(parseWhen('18/10 9:30am', { now: NOW }).ms, ist('2026-10-18T09:30:00'));
});

test('a bare future time means the last one when preferPast is on', () => {
  assert.equal(parseWhen('6pm', { now: NOW, preferPast: true }).ms, ist('2026-10-18T18:00:00'));
  assert.equal(parseWhen('6pm', { now: NOW }).ms, ist('2026-10-19T18:00:00'));
  // an explicit day is never moved
  assert.equal(parseWhen('today 6pm', { now: NOW, preferPast: true }).ms, ist('2026-10-19T18:00:00'));
});

test('message links, IDs and Discord timestamps', () => {
  const id = msToSnowflake(ist('2026-10-19T12:00:00'));
  const link = `https://discord.com/channels/111111111111111111/222222222222222222/${id}`;
  const p = parseWhen(link, { now: NOW });
  assert.equal(p.kind, 'message');
  assert.equal(p.messageId, id);
  assert.equal(p.channelId, '222222222222222222');
  assert.equal(p.ms, ist('2026-10-19T12:00:00'));
  assert.equal(parseWhen(id, { now: NOW }).kind, 'message');
  assert.equal(parseWhen('<t:1760860800:F>', { now: NOW }).ms, 1760860800000);
});

test('nonsense is rejected', () => {
  assert.equal(parseWhen('banana', { now: NOW }), null);
  assert.equal(parseWhen('', { now: NOW }), null);
});

test('formatting', () => {
  assert.match(formatLong(ist('2026-10-19T14:05:00')), /19 Oct,? 2026.*2:05\s?pm IST/i);
  assert.equal(formatDuration(3 * 3600e3 + 20 * 60e3), '3h 20m');
  assert.equal(formatDuration(0), '0m');
});

test('chunking keeps lines whole and under the limit', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i} `.repeat(10));
  const chunks = chunkLines(lines, 500);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 500);
  assert.equal(chunks.join('\n').split('\n').length, 50);
});
