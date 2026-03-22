/**
 * Discord Bot + WebSocket Server — Tampermonkey Remote Control
 */

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require("discord.js");
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

// ─── HTTP keep-alive ──────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => { res.writeHead(200); res.end("OK"); });
httpServer.listen(WS_PORT, () => console.log(`🌐 HTTP server on port ${WS_PORT}`));
if (RENDER_URL) {
  setInterval(() => {
    http.get(RENDER_URL).on("error", err => console.warn("⚠️ Keep-alive failed:", err.message));
    console.log("♻️  Keep-alive ping sent");
  }, 14 * 60 * 1000);
}

// ─── Per-user state ───────────────────────────────────────────────────────────
// username → { messageId, connectedAt, url, inventory, connected }
const userPanels  = new Map();
// username → active WebSocket
const activeSockets = new Map();

function buildEmbed(username, state) {
  const embed = new EmbedBuilder()
    .setTitle(`🖥️ ${username}`)
    .setColor(state.connected ? 0x57F287 : 0xED4245)
    .addFields(
      { name: "Status",       value: state.connected ? "🟢 Connected" : "🔴 Disconnected", inline: true },
      { name: "Connected at", value: state.connectedAt ? `<t:${Math.floor(state.connectedAt / 1000)}:R>` : "—", inline: true },
      { name: "Current URL",  value: state.url ? `\`${state.url}\`` : "—" },
      { name: "📦 Inventory", value: state.inventory?.length
          ? `${state.inventory.length} sellable item(s) — use the button below to browse`
          : "No sellable items / not yet fetched" },
    )
    .setTimestamp();
  return embed;
}

function buildRow(username, page, totalPages) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`inv_prev_${username}_${page}`)
      .setLabel("◀ Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`inv_next_${username}_${page}`)
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= totalPages - 1),
    new ButtonBuilder()
      .setCustomId(`inv_refresh_${username}`)
      .setLabel("🔄 Refresh Inventory")
      .setStyle(ButtonStyle.Success),
  );
  return row;
}

const PAGE_SIZE = 15;

function inventoryPage(inventory, page) {
  const start = page * PAGE_SIZE;
  const items = inventory.slice(start, start + PAGE_SIZE);
  const lines = items.map(item => {
    const listed = item.listed ? `✅ @ ${item.price ?? "?"}` : "❌ not listed";
    return `\`${item.item_id}\` **${item.name}** — ${listed}`;
  });
  return lines.join("\n") || "No items on this page.";
}

// ─── Send/update a user's panel ───────────────────────────────────────────────
async function sendOrUpdatePanel(username) {
  let channel;
  try {
    channel = await client.channels.fetch(CHANNEL_ID);
  } catch (err) {
    console.warn("⚠️ Channel not found:", err.message);
    return;
  }

  const state = userPanels.get(username);
  if (!state) return;

  const embed    = buildEmbed(username, state);
  const inv      = state.inventory || [];
  const totalPages = Math.max(1, Math.ceil(inv.length / PAGE_SIZE));
  const page     = Math.min(state.page || 0, totalPages - 1);
  const row      = buildRow(username, page, totalPages);

  // Inventory page embed (shown alongside main panel)
  const invEmbed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`📦 Inventory — Page ${page + 1}/${totalPages}`)
    .setDescription(inv.length ? inventoryPage(inv, page) : "No sellable items yet.");

  if (state.messageId) {
    try {
      const msg = await channel.messages.fetch(state.messageId);
      await msg.edit({ embeds: [embed, invEmbed], components: [row] });
      return;
    } catch {
      state.messageId = null;
    }
  }

  const msg = await channel.send({ embeds: [embed, invEmbed], components: [row] });
  state.messageId = msg.id;
}

// ─── WebSocket Server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

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

    // Drop existing socket for this user cleanly
    const existing = activeSockets.get(username);
    if (existing && existing !== ws) {
      existing.removeAllListeners();
      existing.close();
    }
    activeSockets.set(username, ws);

    // Preserve panel state (messageId, inventory, page) across reconnects
    const prev = userPanels.get(username) || {};
    userPanels.set(username, {
      ...prev,
      connected:   true,
      connectedAt: Date.now(),
      url,
      inventory:   prev.inventory || [],
      page:        prev.page      || 0,
    });

    ws.send(JSON.stringify({ type: "connected", message: "Authenticated OK" }));
    console.log(`🟢 [${username}] connected — ${url}`);
    sendOrUpdatePanel(username);

    ws.on("close", () => {
      // Only update state if this is still the active socket
      if (activeSockets.get(username) === ws) {
        activeSockets.delete(username);
        const state = userPanels.get(username);
        if (state) { state.connected = false; sendOrUpdatePanel(username); }
        console.log(`🔴 [${username}] disconnected`);
      }
    });

    ws.on("message", (data) => {
      try {
        const m = JSON.parse(data);
        if (m.type === "url_change") {
          const state = userPanels.get(username);
          if (state) { state.url = m.url; sendOrUpdatePanel(username); }
        }
        if (m.type === "inventory") {
          const state = userPanels.get(username);
          if (state) { state.inventory = m.items; state.page = 0; sendOrUpdatePanel(username); }
          console.log(`📦 [${username}] inventory: ${m.items.length} items`);
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

// Ping/pong keep-alive
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
    .addStringOption(opt => opt.setName("username").setDescription("Username").setRequired(true))
    .addNumberOption(opt => opt.setName("itemid").setDescription("Item ID").setRequired(true))
    .addNumberOption(opt => opt.setName("itemprice").setDescription("Item price").setRequired(true)),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show all connected users"),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("✅ Slash commands registered.");
  } catch (err) {
    console.error("❌ Failed to register commands:", err.message);
  }
})();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
client.once("ready", () => console.log(`🤖 Logged in as ${client.user.tag}`));

client.on("interactionCreate", async interaction => {
  // ── Slash commands ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "listitem") {
      const username  = interaction.options.getString("username");
      const itemid    = interaction.options.getNumber("itemid");
      const itemprice = interaction.options.getNumber("itemprice");
      await interaction.deferReply({ ephemeral: true });
      const socket = activeSockets.get(username);
      if (!socket || socket.readyState !== 1) {
        return interaction.editReply(`❌ **${username}** is not connected.`);
      }
      socket.send(JSON.stringify({ type: "run", value1: itemid, value2: itemprice }));
      await interaction.editReply(`✅ Sent to **${username}**!\n\`\`\`\nItem ID:    ${itemid}\nItem Price: ${itemprice}\n\`\`\``);
    }

    else if (interaction.commandName === "status") {
      await interaction.deferReply({ ephemeral: true });
      if (activeSockets.size === 0) return interaction.editReply("🔴 No users connected.");
      const list = [...activeSockets.keys()].map(u => `• **${u}**`).join("\n");
      await interaction.editReply(`🟢 **Connected:**\n${list}`);
    }
  }

  // ── Button interactions ─────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const id = interaction.customId;

    // inv_prev_Username_2  /  inv_next_Username_2
    const navMatch = id.match(/^inv_(prev|next)_(.+)_(\d+)$/);
    if (navMatch) {
      await interaction.deferUpdate();
      const dir      = navMatch[1];
      const username = navMatch[2];
      const curPage  = parseInt(navMatch[3]);
      const state    = userPanels.get(username);
      if (!state) return;
      const totalPages = Math.max(1, Math.ceil((state.inventory || []).length / PAGE_SIZE));
      state.page = dir === "next"
        ? Math.min(curPage + 1, totalPages - 1)
        : Math.max(curPage - 1, 0);
      sendOrUpdatePanel(username);
      return;
    }

    // inv_refresh_Username
    const refreshMatch = id.match(/^inv_refresh_(.+)$/);
    if (refreshMatch) {
      await interaction.deferUpdate();
      const username = refreshMatch[1];
      const socket   = activeSockets.get(username);
      if (socket && socket.readyState === 1) {
        socket.send(JSON.stringify({ type: "fetch_inventory" }));
      }
      return;
    }
  }
});

client.login(DISCORD_TOKEN);
