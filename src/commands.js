import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  InteractionContextType,
  SlashCommandBuilder,
} from 'discord.js';

export const NAMES = {
  summarize: 'summarize',
  fromHere: 'Summarize from here',
  setStart: 'Set summary start',
  upToHere: 'Summarize up to here',
};

const summarize = new SlashCommandBuilder()
  .setName(NAMES.summarize)
  .setDescription('Summarize this channel between two times (IST)')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) =>
    o
      .setName('from')
      .setDescription('Start: "yesterday 6pm", "2h ago", "18/10 9:30am" or a message link')
      .setRequired(true)
      .setMaxLength(100)
      .setAutocomplete(true),
  )
  .addStringOption((o) =>
    o
      .setName('to')
      .setDescription('End (default: now). Same formats as "from".')
      .setRequired(false)
      .setMaxLength(100)
      .setAutocomplete(true),
  );

const messageCommand = (name) =>
  new ContextMenuCommandBuilder()
    .setName(name)
    .setType(ApplicationCommandType.Message)
    .setContexts(InteractionContextType.Guild);

export const commandData = [
  summarize,
  messageCommand(NAMES.fromHere),
  messageCommand(NAMES.setStart),
  messageCommand(NAMES.upToHere),
].map((c) => c.toJSON());
