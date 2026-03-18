/**
 * Discord Bot + WebSocket Server — Tampermonkey Remote Control
 *
 * Setup:
 *   npm install discord.js ws
 *   node server.js
 */

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { WebSocketServer } = require("ws");
const http = require("http");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "YOUR_BOT_TOKEN_HERE";
const CLIENT_ID     = process.env.CLIENT_ID     || "YOUR_CLIENT_ID_HERE";
const CHANNEL_ID    = process.env.CHANNEL_ID    || "YOUR_CHANNEL_ID_HERE";
const RENDER_URL    = process.env.RENDER_URL    || ""; // e.g. https://discordbot-pn5o.onrender.com
const WS_PORT       = process.env.PORT          || 3847;
const WS_SECRET     = process.env.WS_SECRET     || "changeme-secret-key";
// ─────────────────────────────────────────────────────────────────────────────

// ─── HTTP server (required by Render + used for keep-alive pings) ─────────────
const httpServer = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("OK");
});
httpServer.listen(WS_PORT, () => {
  console.log(`🌐 HTTP server on port ${WS_PORT}`);
});

// Self-ping every 14 minutes to prevent Render free tier from sleeping
if (RENDER_URL) {
  setInterval(() => {
    http.get(RENDER_URL).on("error", (err) => {
      console.warn("⚠️  Keep-alive ping failed:", err.message);
    });
    console.log("♻️  Keep-alive ping sent");
  }, 14 * 60 * 1000);
}

// ─── Panel state ──────────────────────────────────────────────────────────────
let panelMessage = null;
let connectedAt  = null;
let currentUrl   = "unknown";
let currentUser  = "unknown";

function buildEmbed(connected) {
  return new EmbedBuilder()
    .setTitle("🖥️ Tampermonkey Remote Control")
    .setColor(connected ? 0x57F287 : 0xED4245)
    .addFields(
      { name: "Status",       value: connected ? "🟢 Connected" : "🔴 Disconnected", inline: true },
      { name: "Username",     value: connected ? currentUser : "—", inline: true },
      { name: "Connected at", value: connectedAt ? `<t:${Math.floor(connectedAt / 1000)}:R>` : "—", inline: true },
      { name: "Current URL",  value: connected ? `\`${currentUrl}\`` : "—" },
    )
    .setTimestamp();
}

async function sendOrUpdatePanel(connected) {
  let channel;
  try {
    channel = await client.channels.fetch(CHANNEL_ID);
  } catch (err) {
    console.warn("⚠️  Panel channel not found — check CHANNEL_ID:", err.message);
    return;
  }

  const embed = buildEmbed(connected);

  if (panelMessage) {
    try {
      await panelMessage.edit({ embeds: [embed] });
      return;
    } catch {
      panelMessage = null;
    }
  }

  panelMessage = await channel.send({ embeds: [embed] });
}

// ─── WebSocket Server (shares port with HTTP via upgrade) ─────────────────────
const wss = new WebSocketServer({ server: httpServer });
let tmSocket = null;

wss.on("connection", (ws) => {
  ws.once("message", (msg) => {
    let parsed;
    try {
      parsed = JSON.parse(msg);
    } catch {
      ws.close();
      return;
    }

    if (parsed.secret !== WS_SECRET) {
      ws.send(JSON.stringify({ type: "error", message: "Unauthorized" }));
      ws.close();
      return;
    }

    if (tmSocket) tmSocket.close();
    tmSocket    = ws;
    connectedAt = Date.now();
    currentUrl  = parsed.url || "unknown";
    currentUser = parsed.username || "unknown";

    ws.send(JSON.stringify({ type: "connected", message: "Authenticated OK" }));
    console.log("🟢 Tampermonkey connected —", currentUrl);
    sendOrUpdatePanel(true);

    ws.on("close", () => {
      if (tmSocket === ws) tmSocket = null;
      console.log("🔴 Tampermonkey disconnected");
      sendOrUpdatePanel(false);
    });

    ws.on("message", (data) => {
      try {
        const m = JSON.parse(data);
        if (m.type === "result") {
          console.log(`📨 Result: ${JSON.stringify(m.data)}`);
        }
        if (m.type === "url_change") {
          currentUrl = m.url;
          console.log("🔗 URL changed:", currentUrl);
          sendOrUpdatePanel(true);
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
    .setDescription("List an item in your Tampermonkey script")
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
    .setDescription("Check if the Tampermonkey script is connected"),
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

client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "listitem") {
    const itemid    = interaction.options.getNumber("itemid");
    const itemprice = interaction.options.getNumber("itemprice");
    await interaction.deferReply();

    if (!tmSocket || tmSocket.readyState !== 1) {
      return interaction.editReply("❌ Tampermonkey is not connected.");
    }

    tmSocket.send(JSON.stringify({ type: "run", value1: itemid, value2: itemprice }));
    await interaction.editReply(`✅ Sent!\n\`\`\`\nItem ID:    ${itemid}\nItem Price: ${itemprice}\n\`\`\``);
  }

  else if (interaction.commandName === "status") {
    await interaction.deferReply();
    const connected = tmSocket && tmSocket.readyState === 1;
    await interaction.editReply(
      connected ? "🟢 Tampermonkey is **connected**." : "🔴 Tampermonkey is **not connected**."
    );
  }
});

client.login(DISCORD_TOKEN);
