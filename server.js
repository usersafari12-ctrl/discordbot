/**
 * Discord Bot + WebSocket Server — Tampermonkey Remote Control
 *
 * Setup:
 *   npm install discord.js ws
 *   node bot.js
 *
 * Slash commands:
 *   /run <argument>  — sends function call directly to Tampermonkey via WebSocket
 *   /status          — shows if Tampermonkey is connected
 */

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const { WebSocketServer } = require("ws");

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "YOUR_BOT_TOKEN_HERE";
const CLIENT_ID     = process.env.CLIENT_ID     || "YOUR_CLIENT_ID_HERE";
const WS_PORT       = process.env.PORT          || process.env.WS_PORT || 3847; // Render sets PORT automatically
const WS_SECRET     = process.env.WS_SECRET     || "changeme-secret-key";
// ───────────────────────────────────────────────────────────────────────────────

// ─── WebSocket Server ─────────────────────────────────────────────────────────
// Bind to 0.0.0.0 so Render exposes it publicly (not just localhost)
const wss = new WebSocketServer({ host: "0.0.0.0", port: WS_PORT });
let tmSocket = null; // the connected Tampermonkey client

wss.on("connection", (ws, req) => {
  // First message must be the secret
  ws.once("message", (msg) => {
    try {
      const { secret } = JSON.parse(msg);
      if (secret !== WS_SECRET) {
        ws.send(JSON.stringify({ type: "error", message: "Unauthorized" }));
        ws.close();
        return;
      }
    } catch {
      ws.close();
      return;
    }

    // Auth passed — accept this as the active Tampermonkey client
    if (tmSocket) tmSocket.close(); // drop any old connection
    tmSocket = ws;
    ws.send(JSON.stringify({ type: "connected", message: "Authenticated OK" }));
    console.log("🟢 Tampermonkey connected");

    ws.on("close", () => {
      if (tmSocket === ws) tmSocket = null;
      console.log("🔴 Tampermonkey disconnected");
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "result") {
          console.log(`📨 Result from Tampermonkey: ${JSON.stringify(msg.data)}`);
        }
      } catch {}
    });

    // Keep-alive: ping every 30s so Render doesn't close the idle connection
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

console.log(`🌐 WebSocket server listening on ws://0.0.0.0:${WS_PORT}`);

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

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", () => console.log(`🤖 Logged in as ${client.user.tag}`));

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "run") {
    const argument = interaction.options.getString("argument");
    await interaction.deferReply();

    if (!tmSocket || tmSocket.readyState !== 1 /* OPEN */) {
      return interaction.editReply("❌ Tampermonkey is not connected. Is the script running in your browser?");
    }

    tmSocket.send(JSON.stringify({ type: "run", argument }));
    await interaction.editReply(`✅ Sent to Tampermonkey!\n\`\`\`\nArgument: ${argument}\n\`\`\``);
  }

  else if (interaction.commandName === "status") {
    await interaction.deferReply();
    const connected = tmSocket && tmSocket.readyState === 1;
    await interaction.editReply(
      connected
        ? "🟢 Tampermonkey is **connected** and ready."
        : "🔴 Tampermonkey is **not connected**."
    );
  }
});

client.login(DISCORD_TOKEN);
