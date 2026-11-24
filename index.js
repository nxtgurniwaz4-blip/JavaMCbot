
"use strict";

const mineflayer = require("mineflayer");
const express = require("express");
const settings = require("./settings.json");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActivityType,
  EmbedBuilder
} = require("discord.js");

// =====================================================
// CONFIGURATION
// =====================================================

const PORT = process.env.PORT || 5000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_ALERT_CHANNEL_ID = process.env.DISCORD_ALERT_CHANNEL_ID || "";
const DISCORD_ADMIN_IDS = (process.env.DISCORD_ADMIN_IDS || "")
  .split(",")
  .map(id => id.trim())
  .filter(Boolean);

const MC_AUTH_PASSWORD =
  process.env.MC_AUTH_PASSWORD ||
  settings.utils?.["auto-auth"]?.password ||
  "";

const RECONNECT_DELAY = 15000;
const INACTIVITY_LIMIT = 120000;
const LOG_LIMIT = 100;

const app = express();

let bot = null;
let running = true;
let connecting = false;
let connected = false;
let reconnectTimer = null;
let movementTimer = null;
let inactivityTimer = null;
let loginTimer = null;
let timeCommandTimer = null;
let botStartedAt = null;

let logs = [];
let connectionAttempts = 0;

// =====================================================
// LOGGING
// =====================================================

function log(message) {
  const entry = `[${new Date().toLocaleString()}] ${message}`;

  console.log(entry);
  logs.push(entry);

  if (logs.length > LOG_LIMIT) {
    logs.shift();
  }
}

function getStatus() {
  return {
    running,
    connecting,
    connected,
    username: settings["bot-account"]?.username || "Unknown",
    server: settings.server?.ip || "Unknown",
    uptime: botStartedAt && connected
      ? Math.floor((Date.now() - botStartedAt) / 1000)
      : 0,
    connectionAttempts
  };
}

// =====================================================
// EXPRESS DASHBOARD
// =====================================================

app.get("/", (req, res) => {
  const status = getStatus();

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Minecraft Bot Dashboard</title>
      <style>
        body {
          background: #0b0c10;
          color: #eee;
          font-family: Arial, sans-serif;
          text-align: center;
          padding: 40px 15px;
        }
        .card {
          max-width: 500px;
          margin: auto;
          padding: 30px;
          background: #1f2833;
          border-radius: 15px;
        }
        h1 { color: #66fcf1; }
        .status { font-size: 22px; margin: 20px; }
        a {
          display: inline-block;
          color: #66fcf1;
          border: 1px solid #66fcf1;
          padding: 12px 20px;
          margin: 8px;
          text-decoration: none;
          border-radius: 7px;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Zooba Minecraft Bot</h1>
        <div class="status">
          ${status.connected ? "🟢 Connected" : status.connecting ? "🟡 Connecting" : "🔴 Disconnected"}
        </div>
        <p>Username: ${status.username}</p>
        <p>Server: ${status.server}</p>
        <p>Connection attempts: ${status.connectionAttempts}</p>
        <a href="/health">Health</a>
        <a href="/logs">Logs</a>
      </div>
    </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.json(getStatus());
});

app.get("/logs", (req, res) => {
  res.type("text/plain").send(logs.join("\n"));
});

app.listen(PORT, () => {
  log(`Dashboard started on port ${PORT}`);
});

// =====================================================
// DISCORD CLIENT
// =====================================================

const discord = new Client({
  intents: [GatewayIntentBits.Guilds]
});

function isAdmin(userId) {
  return DISCORD_ADMIN_IDS.includes(userId);
}

async function sendAlert(message) {
  if (!discord.isReady() || !DISCORD_ALERT_CHANNEL_ID) return;

  try {
    const channel = await discord.channels.fetch(DISCORD_ALERT_CHANNEL_ID);

    if (channel && channel.isTextBased()) {
      await channel.send({
        content: message,
        allowedMentions: { parse: [] }
      });
    }
  } catch (error) {
    log(`Discord alert error: ${error.message}`);
  }
}

// =====================================================
// DISCORD SLASH COMMANDS
// =====================================================

const commands = [
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show available bot commands"),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show Minecraft bot status"),

  new SlashCommandBuilder()
    .setName("players")
    .setDescription("Show players currently online"),

  new SlashCommandBuilder()
    .setName("start")
    .setDescription("Start the Minecraft bot"),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop the Minecraft bot"),

  new SlashCommandBuilder()
    .setName("restart")
    .setDescription("Restart the Minecraft bot"),

  new SlashCommandBuilder()
    .setName("logs")
    .setDescription("Show recent bot logs"),

  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Send a message in Minecraft")
    .addStringOption(option =>
      option
        .setName("message")
        .setDescription("Message to send")
        .setRequired(true)
        .setMaxLength(200)
    )
].map(command => command.toJSON());

async function registerCommands() {
  if (!DISCORD_TOKEN) {
    log("DISCORD_TOKEN is missing. Discord commands are disabled.");
    return;
  }

  try {
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

    await rest.put(
      Routes.applicationCommands(discord.application.id),
      { body: commands }
    );

    log("Discord slash commands registered.");
  } catch (error) {
    log(`Command registration error: ${error.message}`);
  }
}

discord.once("ready", async () => {
  log(`Discord connected as ${discord.user.tag}`);

  await registerCommands();

  discord.user.setPresence({
    activities: [{
      name: "Minecraft",
      type: ActivityType.Playing
    }],
    status: "online"
  });
});

discord.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = interaction.commandName;

  try {
    if (command === "help") {
      return interaction.reply({
        ephemeral: true,
        content:
          "**Minecraft Bot Commands**\n" +
          "`/help` - Show commands\n" +
          "`/status` - Connection status\n" +
          "`/players` - Online players\n" +
          "`/start` - Start bot (admin)\n" +
          "`/stop` - Stop bot (admin)\n" +
          "`/restart` - Restart bot (admin)\n" +
          "`/logs` - Recent logs (admin)\n" +
          "`/say` - Chat in Minecraft (admin)"
      });
    }

    if (command === "status") {
      const status = getStatus();

      const embed = new EmbedBuilder()
        .setTitle("Minecraft Bot Status")
        .setColor(status.connected ? 0x2ecc71 : 0xe74c3c)
        .addFields(
          { name: "Connection", value: status.connected ? "Connected" : status.connecting ? "Connecting" : "Disconnected", inline: true },
          { name: "Username", value: status.username, inline: true },
          { name: "Server", value: status.server, inline: false },
          { name: "Attempts", value: String(status.connectionAttempts), inline: true },
          { name: "Uptime", value: `${status.uptime}s`, inline: true }
        )
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    if (command === "players") {
      if (!connected || !bot) {
        return interaction.reply("The Minecraft bot is not connected.");
      }

      const players = Object.keys(bot.players || {});

      return interaction.reply({
        content: players.length
          ? `**Online players (${players.length}):**\n${players.join(", ")}`
          : "No players found."
      });
    }

    const adminCommands = ["start", "stop", "restart", "logs", "say"];

    if (adminCommands.includes(command) && !isAdmin(interaction.user.id)) {
      return interaction.reply({
        content: "You are not authorized to use this command.",
        ephemeral: true
      });
    }

    if (command === "start") {
      if (running && (connected || connecting)) {
        return interaction.reply("The bot is already running or connecting.");
      }

      running = true;
      startBot();

      return interaction.reply("Starting the Minecraft bot...");
    }

    if (command === "stop") {
      stopBot();

      return interaction.reply("Minecraft bot stopped.");
    }

    if (command === "restart") {
      await interaction.reply("Restarting Minecraft bot...");

      stopBot();
      running = true;

      setTimeout(startBot, 2000);
      return;
    }

    if (command === "logs") {
      const recentLogs = logs.slice(-15).join("\n") || "No logs available.";

      return interaction.reply({
        content: `\`\`\`\n${recentLogs.slice(0, 1900)}\n\`\`\``,
        ephemeral: true
      });
    }

    if (command === "say") {
      if (!connected || !bot) {
        return interaction.reply("The Minecraft bot is not connected.");
      }

      const message = interaction.options.getString("message", true);

      bot.chat(message);

      return interaction.reply({
        content: "Message sent to Minecraft.",
        ephemeral: true
      });
    }
  } catch (error) {
    log(`Discord command error: ${error.message}`);

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: "An error occurred while running that command.",
        ephemeral: true
      }).catch(() => {});
    } else {
      await interaction.reply({
        content: "An error occurred while running that command.",
        ephemeral: true
      }).catch(() => {});
    }
  }
});

// =====================================================
// MINECRAFT TIMER CLEANUP
// =====================================================

function clearBotTimers() {
  clearTimeout(reconnectTimer);
  clearTimeout(inactivityTimer);
  clearTimeout(loginTimer);

  clearInterval(movementTimer);
  clearInterval(timeCommandTimer);

  reconnectTimer = null;
  inactivityTimer = null;
  loginTimer = null;
  movementTimer = null;
  timeCommandTimer = null;
}

function resetInactivityTimer() {
  clearTimeout(inactivityTimer);

  inactivityTimer = setTimeout(() => {
    sendAlert("⚠️ Zooba has not moved for two minutes.");
  }, INACTIVITY_LIMIT);
}

// =====================================================
// MINECRAFT CONNECTION
// =====================================================

function startBot() {
  if (!running) return;

  if (connecting || connected) {
    log("Bot is already connecting or connected.");
    return;
  }

  clearBotTimers();

  const serverIp = settings.server?.ip;
  const serverPort = Number(settings.server?.port || 25565);
  const username = settings["bot-account"]?.username;
  const version = settings.server?.version || false;

  if (!serverIp || !username) {
    log("Missing Minecraft server IP or bot username in settings.json.");
    return;
  }

  connecting = true;
  connected = false;
  connectionAttempts++;

  log(`Connecting to ${serverIp}:${serverPort}...`);

  try {
    bot = mineflayer.createBot({
      host: serverIp,
      port: serverPort,
      username,
      auth: "offline",
      version
    });

    setupBotEvents(bot);
  } catch (error) {
    connecting = false;
    connected = false;

    log(`Could not create Minecraft bot: ${error.message}`);
    scheduleReconnect();
  }
}

function setupBotEvents(currentBot) {
  let ended = false;

  function handleDisconnect(reason) {
    if (ended) return;
    ended = true;

    connecting = false;
    connected = false;

    clearBotTimers();

    if (bot === currentBot) {
      bot = null;
    }

    log(`Minecraft disconnected: ${String(reason || "Unknown reason")}`);

    if (running) {
      sendAlert(`⚠️ Zooba disconnected: ${String(reason || "Unknown reason")}`);
      scheduleReconnect();
    }
  }

  currentBot.once("login", () => {
    connecting = false;
    log("Minecraft login successful.");
  });

  currentBot.once("spawn", () => {
    if (ended || !running) return;

    connecting = false;
    connected = true;
    botStartedAt = Date.now();

    log("Zooba spawned in Minecraft.");
    sendAlert("🟢 Zooba joined the Minecraft server.");

    resetInactivityTimer();

    // Optional server authentication.
    if (MC_AUTH_PASSWORD) {
      loginTimer = setTimeout(() => {
        if (connected && bot === currentBot) {
          currentBot.chat(`/login ${MC_AUTH_PASSWORD}`);
        }
      }, 2500);
    }

    // Anti-AFK movement.
    movementTimer = setInterval(() => {
      if (!connected || bot !== currentBot || !currentBot.entity) return;

      try {
        currentBot.setControlState("forward", true);

        setTimeout(() => {
          if (bot === currentBot && currentBot.entity) {
            currentBot.setControlState("forward", false);
          }
        }, 1000);
      } catch (error) {
        log(`Movement error: ${error.message}`);
      }
    }, 10000);

    // Periodic server command.
    timeCommandTimer = setInterval(() => {
      if (connected && bot === currentBot) {
        try {
          currentBot.chat("/time query day");
        } catch (error) {
          log(`Time command error: ${error.message}`);
        }
      }
    }, 240000);
  });

  currentBot.on("move", () => {
    if (bot === currentBot && connected) {
      resetInactivityTimer();
    }
  });

  currentBot.on("messagestr", message => {
    const lower = String(message).toLowerCase();
    const username = String(settings["bot-account"]?.username || "").toLowerCase();

    if (!lower.includes(username)) return;

    if (
      lower.includes("drowned") ||
      lower.includes("died") ||
      lower.includes("slain") ||
      lower.includes("killed") ||
      lower.includes("shot")
    ) {
      sendAlert(`💀 Minecraft death message: ${message}`);
    }
  });

  currentBot.on("kicked", reason => {
    log(`Minecraft kicked the bot: ${String(reason)}`);
    sendAlert(`⚠️ Zooba was kicked: ${String(reason)}`);
  });

  currentBot.on("error", error => {
    log(`Minecraft error: ${error.message}`);

    connecting = false;
    connected = false;

    if (running) {
      sendAlert(`⚠️ Minecraft error: ${error.message}`);
    }
  });

  currentBot.on("end", reason => {
    handleDisconnect(reason);
  });
}

// =====================================================
// RECONNECT
// =====================================================

function scheduleReconnect() {
  if (!running || reconnectTimer) return;

  log(`Reconnecting in ${RECONNECT_DELAY / 1000} seconds...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    if (running && !connected && !connecting) {
      startBot();
    }
  }, RECONNECT_DELAY);
}

// =====================================================
// STOP BOT
// =====================================================

function stopBot() {
  running = false;
  connecting = false;
  connected = false;

  clearBotTimers();

  if (bot) {
    const oldBot = bot;
    bot = null;

    try {
      oldBot.clearControlStates();
      oldBot.quit("Bot stopped.");
    } catch (error) {
      log(`Shutdown warning: ${error.message}`);
    }
  }

  log("Minecraft bot stopped.");
}

// =====================================================
// SHUTDOWN HANDLING
// =====================================================

async function shutdown() {
  log("Shutting down...");

  stopBot();

  if (discord.isReady()) {
    await discord.destroy();
  }

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.on("unhandledRejection", error => {
  log(`Unhandled rejection: ${error?.message || error}`);
});

process.on("uncaughtException", error => {
  log(`Uncaught exception: ${error.message}`);
});

// =====================================================
// START SERVICES
// =====================================================

if (DISCORD_TOKEN) {
  discord.login(DISCORD_TOKEN).catch(error => {
    log(`Discord login failed: ${error.message}`);
  });
} else {
  log("DISCORD_TOKEN is missing. Discord integration is disabled.");
}

startBot();
