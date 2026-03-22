/**
 * Discord Bot + WebSocket Server — Tampermonkey Remote Control
 * Each username gets their own persistent panel that updates in place.
 */

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { WebSocketServer } = require("ws");
const http = require("http");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "YOUR_BOT_TOKEN_HERE";
const CLIENT_ID     = process.env.CLIENT_ID     || "YOUR_CLIENT_ID_HERE";
const CHANNEL_ID    = process.env.CHANNEL_ID    || "YOUR_CHANNEL_ID_HERE";
const RENDER_URL    = process.env.RENDER_URL    || "";
const WS_PORT       = process.env.PORT          || 3847;
const WS_SECRET     = process.env.WS_SECRET     || "changeme-secret-key";
// ─────────────────────────────────────────────────────────────────────────────

// ─── HTTP keep-alive ─────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => { res.writeHead(200); res.end("OK"); });
httpServer.listen(WS_PORT, () => console.log(`🌐 HTTP server on port ${WS_PORT}`));

if (RENDER_URL) {
  setInterval(() => {
    http.get(RENDER_URL).on("error", err => console.warn("⚠️ Keep-alive failed:", err.message));
    console.log("♻️  Keep-alive ping sent");
  }, 14 * 60 * 1000);
}

// ─── Per-user panel state ─────────────────────────────────────────────────────
// Map of username → { messageId, connectedAt, url, inventory, connected, socket }
const userPanels = new Map();

function buildEmbed(username, state) {
  const connected = state.connected;
  const embed = new EmbedBuilder()
    .setTitle(`🖥️ ${username}`)
    .setColor(connected ? 0x57F287 : 0xED4245)
    .addFields(
      { name: "Status",       value: connected ? "🟢 Connected" : "🔴 Disconnected", inline: true },
      { name: "Connected at", value: state.connectedAt ? `<t:${Math.floor(state.connectedAt / 1000)}:R>` : "—", inline: true },
      { name: "Current URL",  value: state.url ? `\`${state.url}\`` : "—", inline: false },
    );

  if (state.inventory && state.inventory.length > 0) {
    // Show up to 20 items inline to stay under Discord's 6000 char limit
    const lines = state.inventory.slice(0, 20).map(item => {
      const listed = item.listed ? `✅ listed @ ${item.price ?? "?"}` : "❌ not listed";
      return `• \`${item.item_id}\` **${item.name}** — ${listed}`;
    });
    if (state.inventory.length > 20) lines.push(`*…and ${state.inventory.length - 20} more*`);
    embed.addFields({ name: `📦 Inventory (${state.inventory.length} sellable)`, value: lines.join("\n") });
  } else {
    embed.addFields({ name: "📦 Inventory", value: "No sellable items / not yet fetched" });
  }

  embed.setTimestamp();
  return embed;
}

async function sendOrUpdatePanel(username) {
  let channel;
  try {
    channel = await client.channels.fetch(CHANNEL_ID);
  } catch (err) {
    console.warn("⚠️ Panel channel not found:", err.message);
    return;
  }

  const state = userPanels.get(username);
  if (!state) return;
  const embed = buildEmbed(username, state);

  // Try to edit existing message
  if (state.messageId) {
    try {
      const msg = await channel.messages.fetch(state.messageId);
      await msg.edit({ embeds: [embed] });
      return;
    } catch {
      state.messageId = null; // message deleted, send fresh
    }
  }

  // Send new message and save its ID
  const msg = await channel.send({ embeds: [embed] });
  state.messageId = msg.id;
}

// ─── WebSocket Server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

// Map of username → active socket (for /listitem routing)
const activeSockets = new Map();

wss.on("connection", (ws) => {
  ws.once("message", (msg) => {
    let parsed;
    try { parsed = JSON.parse(msg); } catch { ws.close(); return; }

    if (parsed.secret !== WS_SECRET) {
      ws.send(JSON.stringify({ type: "error", message: "Unauthorized" }));
      ws.close();
      return;
    }

    const username = parsed.username || "unknown";
    const url      = parsed.url      || "unknown";

    // Close any old socket for this user
    if (activeSockets.has(username)) activeSockets.get(username).close();
    activeSockets.set(username, ws);

    // Create or update panel state — preserve old inventory and connectedAt on reconnect
    const existing = userPanels.get(username) || {};
    userPanels.set(username, {
      ...existing,
      connected:   true,
      connectedAt: Date.now(),
      url,
      inventory:   existing.inventory || [],
    });

    ws.send(JSON.stringify({ type: "connected", message: "Authenticated OK" }));
    console.log(`🟢 [${username}] connected — ${url}`);
    sendOrUpdatePanel(username);

    ws.on("close", () => {
      if (activeSockets.get(username) === ws) activeSockets.delete(username);
      const state = userPanels.get(username);
      if (state) {
        state.connected = false;
        sendOrUpdatePanel(username);
      }
      console.log(`🔴 [${username}] disconnected`);
    });

    ws.on("message", (data) => {
      try {
        const m = JSON.parse(data);

        if (m.type === "url_change") {
          const state = userPanels.get(username);
          if (state) { state.url = m.url; sendOrUpdatePanel(username); }
          console.log(`🔗 [${username}] URL →`, m.url);
        }

        if (m.type === "inventory") {
          const state = userPanels.get(username);
          if (state) { state.inventory = m.items; sendOrUpdatePanel(username); }
          console.log(`📦 [${username}] inventory received — ${m.items.length} items`);
        }

        if (m.type === "result") {
          console.log(`📨 [${username}] result:`, JSON.stringify(m.data));
        }
      } catch {}
    });

    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
  });
});

const keepAlive = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

wss.on("close", () => clearInterval(keepAlive));

// ─── Discord Bot ──────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("listitem")
    .setDescription("List an item for a connected user")
    .addStringOption(opt =>
      opt.setName("username")
        .setDescription("The username to send the command to")
        .setRequired(true)
    )
    .addNumberOption(opt =>
      opt.setName("itemid")
        .setDescription("The item ID")
        .setRequired(true)
    )
    .addNumberOption(opt =>
      opt.setName("itemprice")
        .setDescription("The item price")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show all connected users"),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
(async () => {
  try {
    console.log("📡 Registering slash commands...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("✅ Slash commands registered.");
  } catch (err) {
    console.error("❌ Failed to register commands:", err.message);
  }
})();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
client.once("ready", () => console.log(`🤖 Logged in as ${client.user.tag}`));

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "listitem") {
    const username  = interaction.options.getString("username");
    const itemid    = interaction.options.getNumber("itemid");
    const itemprice = interaction.options.getNumber("itemprice");
    await interaction.deferReply();

    const socket = activeSockets.get(username);
    if (!socket || socket.readyState !== 1) {
      return interaction.editReply(`❌ **${username}** is not connected.`);
    }

    socket.send(JSON.stringify({ type: "run", value1: itemid, value2: itemprice }));
    await interaction.editReply(`✅ Sent to **${username}**!\n\`\`\`\nItem ID:    ${itemid}\nItem Price: ${itemprice}\n\`\`\``);
  }

  else if (interaction.commandName === "status") {
    await interaction.deferReply();
    if (activeSockets.size === 0) {
      return interaction.editReply("🔴 No users currently connected.");
    }
    const list = [...activeSockets.keys()].map(u => `• **${u}**`).join("\n");
    await interaction.editReply(`🟢 **Connected users:**\n${list}`);
  }
});

client.login(DISCORD_TOKEN);
