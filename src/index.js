import 'dotenv/config';
import http from 'node:http';
import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';

import { NAMES, commandData } from './commands.js';
import { fetchRange, toTranscript } from './fetchMessages.js';
import { SummaryError, summarize } from './summarize.js';
import {
  discordTime,
  formatDuration,
  formatLong,
  msToSnowflake,
  parseWhen,
  snowflakeToMs,
} from './time.js';

// ---- Config ----------------------------------------------------------------
for (const key of ['DISCORD_TOKEN', 'OPENROUTER_API_KEY']) {
  if (!process.env[key]) {
    console.error(`Missing ${key}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}
const GUILD_ID = process.env.GUILD_ID || undefined;
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES) || 1500;
const COOLDOWN_MS = (Number(process.env.COOLDOWN_SECONDS) || 20) * 1000;
const PORT = Number(process.env.PORT) || 3000;
const PENDING_TTL_MS = 30 * 60 * 1000;

// ---- State (in memory; a restart simply forgets it) -------------------------
const lastRun = new Map(); // userId -> timestamp
const busyChannels = new Set(); // channelIds currently being summarized
const pendingStarts = new Map(); // `${userId}:${channelId}` -> { messageId, at }

// ---- Client ----------------------------------------------------------------
// MessageContent must also be switched on in the Developer Portal (Bot page),
// otherwise fetched messages come back with empty text.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  try {
    await c.application.commands.set(commandData, GUILD_ID);
    console.log(GUILD_ID ? `Commands registered in guild ${GUILD_ID}` : 'Commands registered globally');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return await handleAutocomplete(interaction);
    if (interaction.isChatInputCommand() && interaction.commandName === NAMES.summarize) {
      return await handleSlash(interaction);
    }
    if (interaction.isMessageContextMenuCommand()) return await handleMessageMenu(interaction);
  } catch (err) {
    console.error('Interaction failed:', err);
    await safeError(interaction, 'Something went wrong. Please try again.');
  }
});

client.on(Events.Error, (err) => console.error('Client error:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

// ---- Autocomplete: live preview of what the bot understood -------------------
const SUGGESTIONS = {
  from: ['1 hour ago', '3 hours ago', 'today 9am', 'yesterday 6pm', '2 days ago'],
  to: ['now', '1 hour ago', 'today 12pm', 'today 6pm'],
};

function clip(text, max = 100) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const isFrom = focused.name === 'from';
  const typed = String(focused.value ?? '').trim();
  const now = new Date();

  if (!typed) {
    const choices = SUGGESTIONS[isFrom ? 'from' : 'to'].map((s) => {
      const p = parseWhen(s, { now, preferPast: isFrom });
      return { name: clip(`${s}  →  ${formatLong(p.ms)}`), value: s };
    });
    return interaction.respond(choices);
  }

  const parsed = parseWhen(typed, { now, preferPast: isFrom });
  if (!parsed) {
    return interaction.respond([
      { name: clip(`❓ Can't read "${typed}" — try "yesterday 6pm" or "2h ago"`), value: clip(typed) },
    ]);
  }

  let note = '';
  if (parsed.kind === 'message') note = ' (that message)';
  if (parsed.ms > now.getTime() + 60_000) note = isFrom ? ' ⚠️ in the future' : ' (will use now)';
  return interaction.respond([{ name: clip(`→ ${formatLong(parsed.ms)}${note}`), value: clip(typed) }]);
}

// ---- /summarize -------------------------------------------------------------
async function handleSlash(interaction) {
  const now = Date.now();
  const fromRaw = interaction.options.getString('from', true);
  const toRaw = interaction.options.getString('to');

  const from = parseWhen(fromRaw, { now: new Date(now), preferPast: true });
  if (!from) {
    return replyError(
      interaction,
      `I couldn't understand **from**: \`${fromRaw}\`.\nTry \`yesterday 6pm\`, \`2h ago\`, \`18/10 9:30am\`, or paste a message link.`,
    );
  }
  const to = toRaw ? parseWhen(toRaw, { now: new Date(now) }) : { ms: now, kind: 'now' };
  if (!to) {
    return replyError(interaction, `I couldn't understand **to**: \`${toRaw}\`. Leave it empty to mean "now".`);
  }

  for (const [label, p] of [['from', from], ['to', to]]) {
    if (p.channelId && p.channelId !== interaction.channelId) {
      return replyError(interaction, `The **${label}** message link points to a different channel. Run the command in that channel.`);
    }
  }

  const toMs = Math.min(to.ms, now);
  if (from.ms > now) {
    return replyError(interaction, `**from** (${discordTime(from.ms)}) is in the future.`);
  }
  if (from.ms >= toMs) {
    return replyError(interaction, `**from** (${discordTime(from.ms)}) must be before **to** (${discordTime(toMs)}).`);
  }

  // Message boundaries are inclusive and exact; time boundaries cover the whole millisecond.
  const afterId =
    from.kind === 'message'
      ? (BigInt(from.messageId) - 1n).toString()
      : (BigInt(msToSnowflake(from.ms)) - 1n).toString();
  const beforeId =
    to.kind === 'message'
      ?(BigInt(to.messageId) + 1n).toString()
      : msToSnowflake(toMs + 1);

  return runSummary(interaction, { afterId, beforeId, fromMs: from.ms, toMs });
}

// ---- Right-click a message → Apps → ... -------------------------------------
async function handleMessageMenu(interaction) {
  const target = interaction.targetMessage;
  const key = `${interaction.user.id}:${interaction.channelId}`;
  const now = Date.now();

  if (interaction.commandName === NAMES.setStart) {
    pendingStarts.set(key, { messageId: target.id, at: now });
    return interaction.reply({
      flags: MessageFlags.Ephemeral,
      content:
        `✅ Start set at ${target.url} (${discordTime(target.createdTimestamp)}).\n` +
        `Now right-click the **last** message to include → **Apps** → **${NAMES.upToHere}**.`,
    });
  }

  if (interaction.commandName === NAMES.fromHere) {
    return runSummary(interaction, {
      afterId: (BigInt(target.id) - 1n).toString(),
      beforeId: msToSnowflake(now + 1),
      fromMs: target.createdTimestamp,
      toMs: now,
    });
  }

  if (interaction.commandName === NAMES.upToHere) {
    const pending = pendingStarts.get(key);
    if (!pending || now - pending.at > PENDING_TTL_MS) {
      pendingStarts.delete(key);
      return replyError(
        interaction,
        `No start set in this channel yet. Right-click the first message → **Apps** → **${NAMES.setStart}**, then try again.\n` +
          `(Or use **${NAMES.fromHere}** to summarize up to now.)`,
      );
    }
    let [startId, endId] = [BigInt(pending.messageId), BigInt(target.id)];
    if (startId > endId) [startId, endId] = [endId, startId]; // picked in reverse order — fine
    const ran = await runSummary(interaction, {
      afterId: (startId - 1n).toString(),
      beforeId: (endId + 1n).toString(),
      fromMs: snowflakeToMs(startId),
      toMs: snowflakeToMs(endId),
    });
    if (ran) pendingStarts.delete(key);
    return;
  }
}

// ---- The shared pipeline: fetch → transcript → AI → post ---------------------
async function runSummary(interaction, { afterId, beforeId, fromMs, toMs }) {
  const perms = interaction.appPermissions;
  if (perms && !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
    await replyError(interaction, 'I need **View Channel** and **Read Message History** permissions in this channel.');
    return false;
  }

  const userId = interaction.user.id;
  const wait = (lastRun.get(userId) ?? 0) + COOLDOWN_MS - Date.now();
  if (wait > 0) {
    await replyError(interaction, `Please wait ${Math.ceil(wait / 1000)}s before asking for another summary.`);
    return false;
  }
  if (busyChannels.has(interaction.channelId)) {
    await replyError(interaction, 'A summary for this channel is already being written. Give it a moment.');
    return false;
  }

  lastRun.set(userId, Date.now());
  busyChannels.add(interaction.channelId);
  await interaction.deferReply();

  try {
    const channel = interaction.channel ?? (await client.channels.fetch(interaction.channelId));
    const { messages, truncated } = await fetchRange(channel, { afterId, beforeId, max: MAX_MESSAGES });
    const lines = toTranscript(messages, { botId: client.user.id });
    const period = `${discordTime(fromMs)} → ${discordTime(toMs)}`;

    if (!lines.length) {
      const looksLikeMissingIntent = messages.some((m) => !m.author?.bot && !m.content && !m.attachments.size);
      await interaction.editReply(
        looksLikeMissingIntent
          ? `I found ${messages.length} messages but couldn't read their text. Turn on **Message Content Intent** in the Discord Developer Portal (Bot page) and restart me.`
          : `No messages found between ${period}.`,
      );
      return true;
    }

    const { text, model, droppedChunks } = await summarize(lines, {
      channelName: channel.name ?? 'channel',
      rangeLabel: `${formatLong(fromMs)} → ${formatLong(toMs)}`,
    });

    const notes = [];
    if (truncated) notes.push(`only the latest ${MAX_MESSAGES} messages were read`);
    if (droppedChunks) notes.push('the earliest part was skipped because the chat was very long');

    const parts = splitText(text, 4000);
    const first = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`Summary of #${channel.name ?? 'channel'}`)
      .setDescription(parts[0])
      .addFields(
        { name: 'Period', value: `${period}\n(${formatDuration(toMs - fromMs)})`, inline: true },
        { name: 'Messages', value: `${lines.length}`, inline: true },
      )
      .setFooter({ text: clip(`Requested by ${interaction.user.displayName} · ${model}`, 2048) });
    if (notes.length) first.addFields({ name: 'Note', value: `⚠️ ${notes.join('; ')}.` });

    await interaction.editReply({ content: '', embeds: [first] });
    for (const extra of parts.slice(1)) {
      await interaction.followUp({ embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(extra)] });
    }
    return true;
  } catch (err) {
    console.error('Summary failed:', err);
    let msg = err instanceof SummaryError ? err.userMessage : 'Something went wrong while summarizing.';
    if (err?.code === 50001 || err?.code === 50013) {
      msg = 'I don\'t have access to read this channel\'s history.';
    }
    lastRun.delete(userId); // don't make them wait after a failure
    await interaction.editReply(`❌ ${msg}`).catch(() => {});
    return false;
  } finally {
    busyChannels.delete(interaction.channelId);
  }
}

// ---- Helpers ----------------------------------------------------------------
function splitText(text, max) {
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) parts.push(rest);
  return parts.length ? parts : ['(empty)'];
}

function replyError(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function safeError(interaction, content) {
  if (!interaction.isRepliable()) return;
  try {
    if (interaction.deferred || interaction.replied) await interaction.editReply(`❌ ${content}`);
    else await replyError(interaction, content);
  } catch {
    /* interaction expired; nothing to do */
  }
}

// ---- Tiny web server so Render (and an uptime pinger) see the bot is alive ----
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(client.isReady() ? `ok: ${client.user.tag}` : 'starting');
  })
  .listen(PORT, () => console.log(`Health page on port ${PORT}`));

client.login(process.env.DISCORD_TOKEN);
