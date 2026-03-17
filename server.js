/**
 * Discord Bot + WebSocket Server — Tampermonkey Remote Control
 *
 * Setup:
 *   npm install discord.js ws
 *   node server.js
 *
 * Add CHANNEL_ID to your Render env vars:
 *   Right-click the channel in Discord → Copy Channel ID (needs Developer Mode on)
 *
 * Slash commands:
 *   /run <argument>  — sends function call directly to Tampermonkey
 *   /status          — shows connection status
 */

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { WebSocketServer } = require("ws");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "YOUR_BOT_TOKEN_HERE";
const CLIENT_ID     = process.env.CLIENT_ID     || "YOUR_CLIENT_ID_HERE";
const CHANNEL_ID    = process.env.CHANNEL_ID    || "YOUR_CHANNEL_ID_HERE";
const WS_PORT       = process.env.PORT          || process.env.WS_PORT || 3847;
const WS_SECRET     = process.env.WS_SECRET     || "changeme-secret-key";
// ─────────────────────────────────────────────────────────────────────────────

// ─── Panel state ──────────────────────────────────────────────────────────────
let panelMessage = null;
let connectedAt  = null;
let currentUrl   = "unknown";

function buildEmbed(connected) {
  return new EmbedBuilder()
    .setTitle("🖥️ Tampermonkey Remote Control")
    .setColor(connected ? 0x57F287 : 0xED4245)
    .addFields(
      { name: "Status",       value: connected ? "🟢 Connected" : "🔴 Disconnected", inline: true },
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
      panelMessage = null; // message deleted, send a fresh one
    }
  }

  panelMessage = await channel.send({ embeds: [embed] });
}

// ─── WebSocket Server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ host: "0.0.0.0", port: WS_PORT });
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

    // Auth passed
    if (tmSocket) tmSocket.close();
    tmSocket    = ws;
    connectedAt = Date.now();
    currentUrl  = parsed.url || "unknown";

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
console.log(`🌐 WebSocket server on port ${WS_PORT}`);

// ─── Discord Bot ──────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("run")
    .setDescription("Run a function in your Tampermonkey script")
    .addStringOption(opt =>
      opt.setName("argument")
        .setDescription("The argument to pass to the function")
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

  if (interaction.commandName === "run") {
    const argument = interaction.options.getString("argument");
    await interaction.deferReply();

    if (!tmSocket || tmSocket.readyState !== 1) {
      return interaction.editReply("❌ Tampermonkey is not connected.");
    }

    tmSocket.send(JSON.stringify({ type: "run", argument }));
    await interaction.editReply(`✅ Sent!\n\`\`\`\nArgument: ${argument}\n\`\`\``);
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
