require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionContextType,
  ApplicationIntegrationType
} = require("discord.js");

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const https = require("https");

// =====================================================
// JJSTUDIOS ACCOUNT SYSTEM
// =====================================================

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const PORT = process.env.PORT || 3000;
const GUILD_ID = process.env.GUILD_ID || "1552438137299664977";

const FULL_COMMAND_ACCESS_ROLE = "1570780402363400262";
const MAIN_ACCESS_ROLE = "1552637429456961657";
const ADMIN_ROLE = "1569494503662821448";
const MOBILE_MAIN_ROLE = "1554321313332469800";

const USERINFO_ROLES = [
  "1552637829815865414",
  ADMIN_ROLE,
  FULL_COMMAND_ACCESS_ROLE
];

const RESET_COOLDOWN = 15 * 60 * 1000;
const KEY_LIFETIME = 30 * 24 * 60 * 60 * 1000;

const ACCOUNT_CREATED_LOG_CHANNEL_ID = "1572100117605912597";
const SCRIPT_EXECUTION_LOG_CHANNEL_ID = "1572100117605912597";

const EXPIRATION_NOTICE_3_DAYS = 3 * 24 * 60 * 60 * 1000;
const EXPIRATION_NOTICE_15_HOURS = 15 * 60 * 60 * 1000;
const EXPIRATION_NOTICE_CHECK_INTERVAL = 5 * 60 * 1000;

const PINK = 0xF2A9D4;

const DB_BASE = (() => {
  if (process.env.RENDER_DISK_PATH) {
    return process.env.RENDER_DISK_PATH;
  }

  try {
    fs.accessSync("/var/data", fs.constants.W_OK);
    return "/var/data";
  } catch {
    return path.join(__dirname, "data");
  }
})();

const DB_PATH = path.join(DB_BASE, "database.json");

const SCRIPTS = {};

if (!BOT_TOKEN || !CLIENT_ID) {
  console.error("[STARTUP] BOT_TOKEN or CLIENT_ID is missing.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.on("error", (error) => {
  console.error("[DISCORD ERROR]", error);
});

process.on("unhandledRejection", (error) => {
  console.error("[UNHANDLED REJECTION]", error);
});

process.on("uncaughtException", (error) => {
  console.error("[UNCAUGHT EXCEPTION]", error);
});

// =====================================================
// SCRIPT FILES
// =====================================================

for (const [fileName, scriptName] of [
  ["mobile.lua", "mobile"],
  ["main.lua", "main"]
]) {
  const scriptPath = path.join(__dirname, "scripts", fileName);

  try {
    if (!fs.existsSync(scriptPath)) {
      throw new Error("Script file does not exist.");
    }

    SCRIPTS[scriptName] = fs.readFileSync(scriptPath, "utf8");

    console.log(
      `[SCRIPTS] Loaded ${fileName} (${SCRIPTS[scriptName].length} bytes)`
    );
  } catch (error) {
    SCRIPTS[scriptName] = null;
    console.error(`[SCRIPTS] Could not load ${fileName}:`, error.message);
  }
}

// =====================================================
// GENERAL HELPERS
// =====================================================

function now() {
  return Date.now();
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric"
  });
}

function safeString(value) {
  if (typeof value !== "string") return null;
  return value.trim().toLowerCase();
}

function generateKey() {
  return (
    "JAMARI-" +
    crypto.randomBytes(2).toString("hex").toUpperCase() +
    "-" +
    crypto.randomBytes(4).toString("hex").toUpperCase() +
    "-" +
    crypto.randomBytes(1).toString("hex").toUpperCase()
  );
}

function generatePassword() {
  return crypto.randomBytes(12).toString("base64url");
}

function getProductNames(products) {
  const names = [];

  if (products.includes("mobile")) names.push("Mobile");
  if (products.includes("main")) names.push("Main");

  return names.length ? names.join(", ") : "No products";
}

function getExpiration(account) {
  const createdAt = Number(account.keyCreatedAt);

  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    return null;
  }

  return createdAt + KEY_LIFETIME;
}

function isExpired(account) {
  const expiration = getExpiration(account);
  return !expiration || now() >= expiration;
}

function getAccountKeys(db) {
  return Object.keys(db).filter((key) => key !== "__meta");
}

function findAccountByDiscordId(db, discordId) {
  return getAccountKeys(db).find((username) => {
    return String(db[username]?.discordId) === String(discordId);
  }) || null;
}

// =====================================================
// DATABASE
// =====================================================

function readDB() {
  try {
    if (!fs.existsSync(DB_BASE)) {
      fs.mkdirSync(DB_BASE, { recursive: true });
    }

    if (!fs.existsSync(DB_PATH)) {
      fs.writeFileSync(DB_PATH, "{}", "utf8");
      return {};
    }

    const parsed = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid database structure.");
    }

    return parsed;
  } catch (error) {
    console.error("[DATABASE ERROR]", error);

    // Do not overwrite a potentially recoverable database automatically.
    return {};
  }
}

function writeDB(db) {
  try {
    if (!fs.existsSync(DB_BASE)) {
      fs.mkdirSync(DB_BASE, { recursive: true });
    }

    const temporaryPath = DB_PATH + ".tmp";

    fs.writeFileSync(
      temporaryPath,
      JSON.stringify(db, null, 2),
      "utf8"
    );

    fs.renameSync(temporaryPath, DB_PATH);
    return true;
  } catch (error) {
    console.error("[DATABASE WRITE ERROR]", error);
    return false;
  }
}

// =====================================================
// DISCORD ROLE HELPERS
// =====================================================

async function getMemberRoles(userId) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);

    return await guild.members.fetch({
      user: userId,
      force: true
    });
  } catch (error) {
    console.error("[MEMBER FETCH]", error.message);
    return null;
  }
}

function hasAnyRole(member, roleIds) {
  if (!member || !member.roles) return false;

  return roleIds.some((roleId) => member.roles.cache.has(roleId));
}

function hasAccess(member, roleIds = []) {
  if (!member) return false;

  return (
    hasAnyRole(member, [ADMIN_ROLE, FULL_COMMAND_ACCESS_ROLE]) ||
    hasAnyRole(member, roleIds)
  );
}

function isStaff(member) {
  return hasAccess(member, USERINFO_ROLES);
}

function getGrantedScriptsForMember(member) {
  const products = [];

  if (hasAccess(member, [MOBILE_MAIN_ROLE])) {
    products.push("mobile");
  }

  if (hasAccess(member, [MAIN_ACCESS_ROLE])) {
    products.push("main");
  }

  return products;
}

async function setProductRoles(member, products) {
  const shouldHaveMobile = products.includes("mobile");
  const shouldHaveMain = products.includes("main");

  if (shouldHaveMobile) {
    await member.roles.add(MOBILE_MAIN_ROLE);
  } else {
    await member.roles.remove(MOBILE_MAIN_ROLE);
  }

  if (shouldHaveMain) {
    await member.roles.add(MAIN_ACCESS_ROLE);
  } else {
    await member.roles.remove(MAIN_ACCESS_ROLE);
  }
}

// =====================================================
// DM NOTIFICATIONS
// =====================================================

async function sendAccountDM(discordId, embed) {
  if (!discordId) {
    return { sent: false, reason: "No linked Discord account." };
  }

  try {
    const user = await client.users.fetch(String(discordId));
    await user.send({ embeds: [embed] });

    return { sent: true };
  } catch (error) {
    console.error("[ACCOUNT DM ERROR]", error.message);

    return {
      sent: false,
      reason: "The user may have DMs disabled."
    };
  }
}

function createNotificationEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(PINK)
    .setAuthor({ name: "JJSTUDIOS" })
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: "JJSTUDIOS · Account Notifications" })
    .setTimestamp();
}

function createRevokedEmbed(account, staffUser) {
  const products = getProductNames(
    Array.isArray(account.allowedScripts) ? account.allowedScripts : []
  );

  return createNotificationEmbed(
    "Access Revoked",
    "Your JJSTUDIOS access has been revoked.\n\n" +
    "Your account and script access are no longer available."
  ).addFields(
    {
      name: "Products",
      value: products,
      inline: true
    },
    {
      name: "Revoked By",
      value: `${staffUser} (${staffUser.username})`,
      inline: false
    },
    {
      name: "Revoked At",
      value: `<t:${Math.floor(now() / 1000)}:F>`,
      inline: false
    }
  );
}

function createHwidResetEmbed(account) {
  return createNotificationEmbed(
    "HWID Reset",
    "Your device lock has been reset successfully.\n\n" +
    "Your next supported loader authentication will register the device again."
  ).addFields(
    {
      name: "Account",
      value: "`" + String(account.username || "Your account") + "`",
      inline: true
    },
    {
      name: "Products",
      value: getProductNames(account.allowedScripts || []),
      inline: true
    },
    {
      name: "Reset Time",
      value: `<t:${Math.floor(now() / 1000)}:F>`,
      inline: false
    }
  );
}

// =====================================================
// ACCOUNT LOGS
// =====================================================

async function sendAccountLog(embed) {
  try {
    const channel = await client.channels.fetch(
      ACCOUNT_CREATED_LOG_CHANNEL_ID
    );

    if (!channel?.isTextBased() || !channel.send) {
      throw new Error("Account log channel is unavailable.");
    }

    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error("[ACCOUNT LOG ERROR]", error.message);
  }
}

async function sendScriptExecutionLog(
  username,
  scriptName,
  discordId,
  executorName
) {
  try {
    const channel = await client.channels.fetch(
      SCRIPT_EXECUTION_LOG_CHANNEL_ID
    );

    if (!channel?.isTextBased() || !channel.send) return;

    const embed = new EmbedBuilder()
      .setColor(PINK)
      .setTitle("LOADER AUTHENTICATED")
      .setDescription("A loader request passed account authentication.")
      .addFields(
        {
          name: "Account",
          value: "`" + username + "`",
          inline: true
        },
        {
          name: "Script",
          value: scriptName === "main" ? "Main" : "Mobile",
          inline: true
        },
        {
          name: "Executor",
          value: "`" + String(executorName || "Unknown").slice(0, 100) + "`",
          inline: true
        },
        {
          name: "Discord User",
          value: discordId ? `<@${discordId}>` : "Not linked",
          inline: true
        },
        {
          name: "Time",
          value: `<t:${Math.floor(now() / 1000)}:F>`,
          inline: false
        }
      )
      .setFooter({ text: "JJSTUDIOS · Execution Logs" })
      .setTimestamp();

    await channel.send({
      embeds: [embed],
      allowedMentions: { parse: [] }
    });
  } catch (error) {
    console.error("[EXECUTION LOG ERROR]", error.message);
  }
}

// =====================================================
// LOADER API
// =====================================================

function createLoadHandler(scriptName) {
  return async (req, res) => {
    try {
      const db = readDB();

      if (db.__meta?.maintenanceMode) {
        return res.json({
          success: false,
          reason: "The service is currently unavailable."
        });
      }

      const { username, key, hwid, executor } = req.body || {};
      const cleanUsername = safeString(username);

      if (
        !cleanUsername ||
        typeof key !== "string" ||
        !key.trim() ||
        typeof hwid !== "string" ||
        !hwid.trim()
      ) {
        return res.status(400).json({
          success: false,
          reason: "Username, key, and HWID are required."
        });
      }

      const account = db[cleanUsername];

      if (!account) {
        return res.json({
          success: false,
          reason: "Account not found."
        });
      }

      if (account.status !== "active") {
        return res.json({
          success: false,
          reason: "Your account is disabled."
        });
      }

      if (account.key !== key.trim()) {
        return res.json({
          success: false,
          reason: "Invalid key."
        });
      }

      if (isExpired(account)) {
        return res.json({
          success: false,
          reason: "Your key has expired."
        });
      }

      if (
        !Array.isArray(account.allowedScripts) ||
        !account.allowedScripts.includes(scriptName)
      ) {
        return res.json({
          success: false,
          reason: "No access."
        });
      }

      const cleanHwid = hwid.trim();

      if (!account.hwid) {
        account.hwid = cleanHwid;
        account.hwidLockedAt = now();
      } else if (account.hwid !== cleanHwid) {
        return res.json({
          success: false,
          reason: "HWID mismatch."
        });
      }

      account.executions = (Number(account.executions) || 0) + 1;
      account.lastExecutionAt = now();

      if (!writeDB(db)) {
        return res.status(500).json({
          success: false,
          reason: "Unable to update account."
        });
      }

      const scriptCode = SCRIPTS[scriptName];

      if (!scriptCode) {
        return res.json({
          success: false,
          reason: "Script file is unavailable."
        });
      }

      const encodedScript = JSON.stringify(scriptCode);

      const finalScript = [
        "task.spawn(function()",
        "  local success, err = pcall(function()",
        "    local func, compileErr = loadstring(" + encodedScript + ")",
        "    if not func then error(compileErr or 'Failed to compile script') end",
        "    return func()",
        "  end)",
        "  if not success then error(err or 'Unknown Lua error') end",
        "end)"
      ].join("\n");

      void sendScriptExecutionLog(
        cleanUsername,
        scriptName,
        account.discordId,
        executor
      );

      return res.json({
        success: true,
        chunk: finalScript
      });
    } catch (error) {
      console.error("[LOADER ERROR]", error);

      return res.status(500).json({
        success: false,
        reason: "Something went wrong."
      });
    }
  };
}

app.post("/load/main", createLoadHandler("main"));
app.post("/load/mobile", createLoadHandler("mobile"));

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    system: "JJSTUDIOS Account System",
    scriptsLoaded: Object.keys(SCRIPTS).filter(
      (name) => Boolean(SCRIPTS[name])
    )
  });
});

// =====================================================
// LUA LOADER TEMPLATE
// =====================================================

function createLuaTemplate(username, key, endpoint, displayName) {
  const domain = process.env.RENDER_EXTERNAL_URL
    ? process.env.RENDER_EXTERNAL_URL.replace(/^https?:\/\//, "")
    : (process.env.DOMAIN || "localhost:3000");

  return [
    `-- ${displayName} : -- /jamari Loader`,
    `local USERNAME = "${username}"`,
    `local KEY = "${key}"`,
    `local HWID = game:GetService("RbxAnalyticsService"):GetClientId()`,
    `local HttpService = game:GetService("HttpService")`,
    "",
    "local executorName = 'Unknown'",
    "pcall(function()",
    "  if type(identifyexecutor) == 'function' then",
    "    executorName = tostring(identifyexecutor())",
    "  elseif type(getexecutorname) == 'function' then",
    "    executorName = tostring(getexecutorname())",
    "  end",
    "end)",
    "",
    "local ok, response = pcall(function()",
    "  local request = (request or (syn and syn.request) or (http and http.request) or (fluxus and fluxus.request))",
    "  if not request then error('Executor does not support HTTP requests.') end",
    "  return request({",
    `    Url = "https://${domain}/load/${endpoint}",`,
    "    Method = 'POST',",
    "    Headers = { ['Content-Type'] = 'application/json' },",
    "    Body = HttpService:JSONEncode({",
    "      username = USERNAME,",
    "      key = KEY,",
    "      hwid = HWID,",
    "      executor = executorName",
    "    })",
    "  })",
    "end)",
    "",
    "if not ok then error('Could not reach the JJSTUDIOS server: ' .. tostring(response)) end",
    "local data = HttpService:JSONDecode(response.Body)",
    "if not data.success then",
    "  error(data.reason or 'Unknown error')",
    "end",
    "loadstring(data.chunk)()"
  ].join("\n");
}

// =====================================================
// CUSTOMER PROFILE
// =====================================================

function createCustomerProfileEmbed(user, account) {
  const tickets = Array.isArray(account.tickets) ? account.tickets : [];
  const products = getProductNames(account.allowedScripts || []);
  const expiration = getExpiration(account);

  return new EmbedBuilder()
    .setColor(PINK)
    .setAuthor({
      name: "JJSTUDIOS",
      iconURL: user.displayAvatarURL({ size: 128 })
    })
    .setTitle("Customer Profile")
    .setDescription(user.toString())
    .addFields(
      {
        name: "Products",
        value: products,
        inline: false
      },
      {
        name: "Account Status",
        value: account.status || "active",
        inline: true
      },
      {
        name: "HWID",
        value: account.hwid ? "Locked" : "Open",
        inline: true
      },
      {
        name: "Executions",
        value: String(Number(account.executions) || 0),
        inline: true
      },
      {
        name: "Tickets",
        value: String(tickets.length),
        inline: true
      },
      {
        name: "Created",
        value: `<t:${Math.floor((account.createdAt || account.keyCreatedAt || now()) / 1000)}:f>`,
        inline: true
      },
      {
        name: "Expires",
        value: expiration
          ? `<t:${Math.floor(expiration / 1000)}:F>`
          : "Unavailable",
        inline: false
      }
    )
    .setFooter({ text: "JJSTUDIOS · Customer Panel" });
}

function createCustomerProfileComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("jj_accounts_reset")
        .setLabel("Request HWID Reset")
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId("jj_accounts_issues")
        .setLabel("Known Issues")
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId("jj_accounts_updates")
        .setLabel("Latest Updates")
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId("jj_accounts_tickets")
        .setLabel("My Tickets")
        .setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("jj_accounts_notifications")
        .setLabel("Notification Preferences")
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId("jj_accounts_refresh")
        .setLabel("Refresh")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

// =====================================================
// MAIN CUSTOMER PANEL
// =====================================================

function createPanel() {
  const embed = new EmbedBuilder()
    .setColor(0xEAF4FF)
    .setTitle("☁️ ୨୧ jamari script panel ୨୧ ☁️")
    .setDescription(
      "˚₊‧꒰ა Welcome to the heavenly control panel ໒꒱‧₊˚\n\n" +
      "Register an account\n" +
      "Get your key\n" +
      "Main loader\n" +
      "Mobile loader\n" +
      "Reset HWID\n\n" +
      "˚₊‧ May your day be full of sunshine and stardust ‧₊˚"
    )
    .addFields({
      name: "Available Actions",
      value: "Register · Get Key · Main · Mobile · Reset HWID"
    })
    .setFooter({ text: "JJSTUDIOS" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("jc_register")
      .setLabel("Register")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("jc_key")
      .setLabel("Get Key")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("jc_main")
      .setLabel("Main")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("jc_mobilemain")
      .setLabel("Mobile")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("jc_resethwid")
      .setLabel("Reset HWID")
      .setStyle(ButtonStyle.Danger)
  );

  return {
    embeds: [embed],
    components: [row]
  };
}

function createPanelModal(action) {
  const titles = {
    register: "Register",
    key: "Get Key",
    main: "Main Loader",
    mobilemain: "Mobile Loader",
    resethwid: "Reset HWID"
  };

  const modal = new ModalBuilder()
    .setCustomId("jc_modal_" + action)
    .setTitle(titles[action] || "JJSTUDIOS");

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("username")
        .setLabel("Username")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("password")
        .setLabel("Password")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    )
  );

  if (action === "main" || action === "mobilemain") {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("key")
          .setLabel("Key")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );
  }

  return modal;
}

// =====================================================
// SLASH COMMAND BUILDERS
// =====================================================

function applyCommandContexts(builder) {
  builder.setContexts(
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel
  );

  builder.setIntegrationTypes(
    ApplicationIntegrationType.GuildInstall,
    ApplicationIntegrationType.UserInstall
  );

  return builder;
}

function buildJamariCommand() {
  const builder = applyCommandContexts(
    new SlashCommandBuilder()
      .setName("jamari")
      .setDescription("Legacy loader commands")
  );

  builder
    .addSubcommand((sub) =>
      sub.setName("panel").setDescription("Open the customer panel")
    )
    .addSubcommand((sub) =>
      sub
        .setName("setpanel")
        .setDescription("Send the customer panel to a channel")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Target channel")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("accountstatus")
        .setDescription("Check an account")
        .addStringOption((option) =>
          option.setName("username").setDescription("Username").setRequired(true)
        )
        .addStringOption((option) =>
          option.setName("password").setDescription("Password").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("changepassword")
        .setDescription("Change an account password")
        .addStringOption((option) =>
          option.setName("username").setDescription("Username").setRequired(true)
        )
        .addStringOption((option) =>
          option.setName("old_password").setDescription("Current password").setRequired(true)
        )
        .addStringOption((option) =>
          option.setName("new_password").setDescription("New password").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("showuserinfo")
        .setDescription("View account information without credentials")
        .addStringOption((option) =>
          option.setName("lookup").setDescription("Username").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("accounts").setDescription("List registered accounts")
    )
    .addSubcommand((sub) =>
      sub
        .setName("revoke")
        .setDescription("Disable an account")
        .addUserOption((option) =>
          option.setName("user").setDescription("Discord user").setRequired(true)
        )
    );

  return builder.toJSON();
}

function buildJJStudiosCommand() {
  const builder = applyCommandContexts(
    new SlashCommandBuilder()
      .setName("jjstudios")
      .setDescription("JJSTUDIOS account management")
  );

  const productOption = (option) =>
    option
      .setName("products")
      .setDescription("Products to assign")
      .setRequired(true)
      .addChoices(
        { name: "Mobile", value: "mobile" },
        { name: "Main", value: "main" },
        { name: "Both", value: "both" }
      );

  builder
    .addSubcommand((sub) =>
      sub.setName("account").setDescription("View your linked account")
    )
    .addSubcommand((sub) =>
      sub
        .setName("scripts")
        .setDescription("Get your available loader script")
    )
    .addSubcommand((sub) =>
      sub
        .setName("grant")
        .setDescription("Create a new buyer account")
        .addUserOption((option) =>
          option.setName("user").setDescription("Buyer").setRequired(true)
        )
        .addStringOption((option) =>
          option.setName("username").setDescription("New username").setRequired(true)
        )
        .addStringOption(productOption)
    )
    .addSubcommand((sub) =>
      sub
        .setName("revoke")
        .setDescription("Delete an account and revoke its access")
        .addUserOption((option) =>
          option.setName("user").setDescription("Buyer").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("disable")
        .setDescription("Temporarily disable an account")
        .addUserOption((option) =>
          option.setName("user").setDescription("Buyer").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("enable")
        .setDescription("Enable an account")
        .addUserOption((option) =>
          option.setName("user").setDescription("Buyer").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("editproducts")
        .setDescription("Change a buyer's products")
        .addUserOption((option) =>
          option.setName("user").setDescription("Buyer").setRequired(true)
        )
        .addStringOption(productOption)
    )
    .addSubcommand((sub) =>
      sub
        .setName("lookup")
        .setDescription("Look up an account without showing credentials")
        .addStringOption((option) =>
          option
            .setName("username")
            .setDescription("Account username")
            .setRequired(false)
        )
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("Linked Discord user")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("adminpanel")
        .setDescription("Post the JJSTUDIOS staff command panel")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Channel for the staff panel")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("apicheck")
        .setDescription("Check the account system status")
    );

  return builder.toJSON();
}

const commandLayouts = [
  buildJamariCommand(),
  buildJJStudiosCommand()
];

// =====================================================
// STAFF COMMAND HELPERS
// =====================================================

async function requireStaff(interaction) {
  const member = await getMemberRoles(interaction.user.id);

  if (!isStaff(member)) {
    await interaction.editReply({
      content: "You do not have permission to use this command."
    });

    return null;
  }

  return member;
}

function getProductsFromChoice(choice) {
  if (choice === "both") return ["mobile", "main"];
  if (choice === "mobile") return ["mobile"];
  if (choice === "main") return ["main"];

  return [];
}

function createAccountRecord(username, password, discordId, products) {
  const createdAt = now();

  return {
    username,
    password,
    key: generateKey(),
    hwid: null,
    hwidLockedAt: null,
    lastHwidReset: 0,
    status: "active",
    allowedScripts: products,
    discordId: String(discordId),
    keyCreatedAt: createdAt,
    createdAt,
    executions: 0,
    tickets: [],
    moderationHistory: [],
    hwidResetHistory: [],
    staffNotes: [],
    flags: [],
    expirationNotices: {}
  };
}

function createGrantDM(username, account) {
  const expiresAt = getExpiration(account);

  return new EmbedBuilder()
    .setColor(PINK)
    .setAuthor({ name: "JJSTUDIOS" })
    .setTitle("Your JJSTUDIOS Account")
    .setDescription(
      "Your account has been created successfully!\n\n" +
      "Keep your login information private."
    )
    .addFields(
      {
        name: "Username",
        value: "`" + username + "`",
        inline: true
      },
      {
        name: "Password",
        value: "`" + account.password + "`",
        inline: true
      },
      {
        name: "Key",
        value: "`" + account.key + "`",
        inline: false
      },
      {
        name: "Products",
        value: getProductNames(account.allowedScripts),
        inline: true
      },
      {
        name: "Expires",
        value: expiresAt ? `<t:${Math.floor(expiresAt / 1000)}:F>` : "Unavailable",
        inline: false
      }
    )
    .setFooter({ text: "JJSTUDIOS · Keep these details private" })
    .setTimestamp();
}

function createStaffPanelEmbed() {
  return new EmbedBuilder()
    .setColor(PINK)
    .setTitle("JJSTUDIOS Account System")
    .setDescription(
      "Staff command reference.\n\n" +
      "**Account Management**\n" +
      "`/jjstudios grant` — Create a buyer account\n" +
      "`/jjstudios revoke` — Delete an account and revoke access\n" +
      "`/jjstudios disable` — Temporarily disable an account\n" +
      "`/jjstudios enable` — Re-enable an account\n" +
      "`/jjstudios editproducts` — Change buyer products\n" +
      "`/jjstudios lookup` — View account information\n\n" +
      "**System Tools**\n" +
      "`/jjstudios apicheck` — Check system health\n" +
      "`/jjstudios adminpanel` — Post this panel\n\n" +
      "**Buyer Commands**\n" +
      "`/jjstudios account` — View your account\n" +
      "`/jjstudios scripts` — Get your loader"
    )
    .setFooter({ text: "JJSTUDIOS · Staff Panel" })
    .setTimestamp();
}

function createAccountInfoEmbed(username, account) {
  const expiration = getExpiration(account);

  return new EmbedBuilder()
    .setColor(PINK)
    .setTitle("Account Lookup")
    .addFields(
      {
        name: "Username",
        value: "`" + username + "`",
        inline: true
      },
      {
        name: "Discord User",
        value: account.discordId ? `<@${account.discordId}>` : "Not linked",
        inline: true
      },
      {
        name: "Status",
        value: account.status || "active",
        inline: true
      },
      {
        name: "Products",
        value: getProductNames(account.allowedScripts || []),
        inline: true
      },
      {
        name: "HWID",
        value: account.hwid ? "Locked" : "Open",
        inline: true
      },
      {
        name: "Executions",
        value: String(Number(account.executions) || 0),
        inline: true
      },
      {
        name: "Expiration",
        value: expiration ? `<t:${Math.floor(expiration / 1000)}:F>` : "Unavailable",
        inline: false
      }
    )
    .setFooter({ text: "JJSTUDIOS · Private Staff Lookup" })
    .setTimestamp();
}

// =====================================================
// JJSTUDIOS COMMAND HANDLER
// =====================================================

async function handleJJStudiosCommand(interaction) {
  const subcommand = interaction.options.getSubcommand();
  const db = readDB();

  // Customer: own account
  if (subcommand === "account") {
    const username = findAccountByDiscordId(db, interaction.user.id);

    if (!username) {
      return interaction.editReply({
        content: "You do not have a linked JJSTUDIOS account."
      });
    }

    const account = db[username];

    return interaction.editReply({
      embeds: [createAccountInfoEmbed(username, account)]
    });
  }

  // Customer: get their own loader
  if (subcommand === "scripts") {
    const username = findAccountByDiscordId(db, interaction.user.id);

    if (!username) {
      return interaction.editReply({
        content: "You do not have a linked JJSTUDIOS account."
      });
    }

    const account = db[username];

    if (account.status !== "active" || isExpired(account)) {
      return interaction.editReply({
        content: "Your account is disabled or expired."
      });
    }

    const products = Array.isArray(account.allowedScripts)
      ? account.allowedScripts
      : [];

    if (!products.length) {
      return interaction.editReply({
        content: "Your account does not have any active products."
      });
    }

    const messages = [];

    for (const product of products) {
      if (!SCRIPTS[product]) continue;

      const loader = createLuaTemplate(
        username,
        account.key,
        product,
        product === "main" ? "JJSTUDIOS Main" : "JJSTUDIOS Mobile"
      );

      messages.push({
        name: product === "main" ? "Main Loader" : "Mobile Loader",
        value: loader
      });
    }

    if (!messages.length) {
      return interaction.editReply({
        content: "Your script files are currently unavailable."
      });
    }

    await interaction.editReply({
      content: "Your available loader script(s):"
    });

    for (const item of messages) {
      await interaction.followUp({
        content: `**${item.name}**\n\`\`\`lua\n${item.value.slice(0, 1800)}\n\`\`\``,
        flags: MessageFlags.Ephemeral
      });
    }

    return;
  }

  // All remaining commands are staff-only.
  const staffMember = await requireStaff(interaction);
  if (!staffMember) return;

  // Grant: create account
  if (subcommand === "grant") {
    const targetUser = interaction.options.getUser("user");
    const username = safeString(interaction.options.getString("username"));
    const products = getProductsFromChoice(
      interaction.options.getString("products")
    );

    if (!username || username === "__meta") {
      return interaction.editReply({
        content: "That username is not valid."
      });
    }

    if (db[username]) {
      return interaction.editReply({
        content: "That username is already taken."
      });
    }

    if (findAccountByDiscordId(db, targetUser.id)) {
      return interaction.editReply({
        content: "That Discord user already has a linked account."
      });
    }

    let targetMember;

    try {
      targetMember = await interaction.guild.members.fetch(targetUser.id);
    } catch {
      return interaction.editReply({
        content: "That user must be a member of this server before you can grant access."
      });
    }

    const password = generatePassword();
    const account = createAccountRecord(
      username,
      password,
      targetUser.id,
      products
    );

    db[username] = account;

    if (!writeDB(db)) {
      delete db[username];

      return interaction.editReply({
        content: "The account could not be saved. Check the database."
      });
    }

    try {
      await setProductRoles(targetMember, products);
    } catch (error) {
      console.error("[GRANT ROLE ERROR]", error);
    }

    const dmResult = await sendAccountDM(
      targetUser.id,
      createGrantDM(username, account)
    );

    await sendAccountLog(
      new EmbedBuilder()
        .setColor(PINK)
        .setTitle("ACCOUNT GRANTED")
        .setDescription("A staff member created a new buyer account.")
        .addFields(
          { name: "Username", value: "`" + username + "`", inline: true },
          { name: "Buyer", value: targetUser.toString(), inline: true },
          { name: "Products", value: getProductNames(products), inline: true },
          { name: "Granted By", value: interaction.user.toString(), inline: true },
          { name: "DM", value: dmResult.sent ? "Delivered" : "Not delivered", inline: true }
        )
        .setTimestamp()
    );

    return interaction.editReply({
      content:
        `Account created for ${targetUser}.\n` +
        `**Username:** \`${username}\`\n` +
        `**Products:** ${getProductNames(products)}\n` +
        `**Buyer DM:** ${dmResult.sent ? "Sent" : "Could not be delivered"}\n\n` +
        "The password and key were sent privately to the buyer."
    });
  }

  // Revoke: remove account completely
  if (subcommand === "revoke") {
    const targetUser = interaction.options.getUser("user");
    const username = findAccountByDiscordId(db, targetUser.id);

    if (!username || !db[username]) {
      return interaction.editReply({
        content: "No linked account was found for that user."
      });
    }

    const account = db[username];

    const revokedEmbed = createRevokedEmbed(account, interaction.user);

    let targetMember = null;

    try {
      targetMember = await interaction.guild.members.fetch(targetUser.id);
    } catch {}

    if (targetMember) {
      try {
        await targetMember.roles.remove([
          MAIN_ACCESS_ROLE,
          MOBILE_MAIN_ROLE
        ]);
      } catch (error) {
        console.error("[REVOKE ROLE ERROR]", error);
      }
    }

    delete db[username];

    if (!writeDB(db)) {
      db[username] = account;

      return interaction.editReply({
        content: "The account could not be deleted from the database."
      });
    }

    const dmResult = await sendAccountDM(targetUser.id, revokedEmbed);

    await sendAccountLog(
      new EmbedBuilder()
        .setColor(PINK)
        .setTitle("ACCOUNT REVOKED")
        .setDescription("A buyer account was deleted.")
        .addFields(
          { name: "Username", value: "`" + username + "`", inline: true },
          { name: "Buyer", value: targetUser.toString(), inline: true },
          { name: "Revoked By", value: interaction.user.toString(), inline: true },
          { name: "Products", value: getProductNames(account.allowedScripts || []), inline: true },
          { name: "Buyer DM", value: dmResult.sent ? "Sent" : "Not delivered", inline: true }
        )
        .setTimestamp()
    );

    return interaction.editReply({
      content:
        `Access revoked for ${targetUser}.\n` +
        `**Account:** \`${username}\`\n` +
        "**Account deleted:** Yes\n" +
        "**Product roles removed:** Yes\n" +
        `**Revocation DM:** ${dmResult.sent ? "Sent" : "Could not be delivered"}`
    });
  }

  // Disable: keep account but block access
  if (subcommand === "disable") {
    const targetUser = interaction.options.getUser("user");
    const username = findAccountByDiscordId(db, targetUser.id);

    if (!username) {
      return interaction.editReply({
        content: "No linked account was found."
      });
    }

    db[username].status = "disabled";
    db[username].moderationHistory ||= [];

    db[username].moderationHistory.push({
      action: "disabled",
      by: interaction.user.id,
      at: now()
    });

    if (!writeDB(db)) {
      return interaction.editReply({
        content: "Could not save the account change."
      });
    }

    const embed = createNotificationEmbed(
      "Account Disabled",
      "Your JJSTUDIOS account has been disabled by staff."
    ).addFields(
      { name: "Disabled By", value: interaction.user.toString(), inline: true },
      { name: "Time", value: `<t:${Math.floor(now() / 1000)}:F>`, inline: true }
    );

    const dmResult = await sendAccountDM(targetUser.id, embed);

    return interaction.editReply({
      content: `Disabled ${targetUser}'s account. Buyer DM: ${dmResult.sent ? "Sent" : "Not delivered"}.`
    });
  }

  // Enable: restore account
  if (subcommand === "enable") {
    const targetUser = interaction.options.getUser("user");
    const username = findAccountByDiscordId(db, targetUser.id);

    if (!username) {
      return interaction.editReply({
        content: "No linked account was found."
      });
    }

    db[username].status = "active";
    db[username].moderationHistory ||= [];

    db[username].moderationHistory.push({
      action: "enabled",
      by: interaction.user.id,
      at: now()
    });

    if (!writeDB(db)) {
      return interaction.editReply({
        content: "Could not save the account change."
      });
    }

    const embed = createNotificationEmbed(
      "Account Enabled",
      "Your JJSTUDIOS account has been enabled again."
    ).addFields(
      { name: "Enabled By", value: interaction.user.toString(), inline: true },
      { name: "Time", value: `<t:${Math.floor(now() / 1000)}:F>`, inline: true }
    );

    const dmResult = await sendAccountDM(targetUser.id, embed);

    return interaction.editReply({
      content: `Enabled ${targetUser}'s account. Buyer DM: ${dmResult.sent ? "Sent" : "Not delivered"}.`
    });
  }

  // Edit products
  if (subcommand === "editproducts") {
    const targetUser = interaction.options.getUser("user");
    const products = getProductsFromChoice(
      interaction.options.getString("products")
    );

    const username = findAccountByDiscordId(db, targetUser.id);

    if (!username) {
      return interaction.editReply({
        content: "No linked account was found."
      });
    }

    let targetMember;

    try {
      targetMember = await interaction.guild.members.fetch(targetUser.id);
    } catch {
      return interaction.editReply({
        content: "The buyer must be in the server to update their product roles."
      });
    }

    try {
      await setProductRoles(targetMember, products);
    } catch (error) {
      console.error("[EDIT PRODUCTS ROLE ERROR]", error);

      return interaction.editReply({
        content: "Could not update the buyer's Discord roles. Check the bot's role permissions and role position."
      });
    }

    db[username].allowedScripts = products;

    if (!writeDB(db)) {
      return interaction.editReply({
        content: "The roles were changed, but the database could not be saved. Check the database."
      });
    }

    const embed = createNotificationEmbed(
      "Product Access Updated",
      "Your JJSTUDIOS product access has been updated."
    ).addFields({
      name: "Your Products",
      value: getProductNames(products),
      inline: false
    });

    const dmResult = await sendAccountDM(targetUser.id, embed);

    return interaction.editReply({
      content:
        `Updated products for ${targetUser}.\n` +
        `**Products:** ${getProductNames(products)}\n` +
        `**Buyer DM:** ${dmResult.sent ? "Sent" : "Not delivered"}`
    });
  }

  // Lookup
  if (subcommand === "lookup") {
    const usernameInput = safeString(
      interaction.options.getString("username")
    );

    const targetUser = interaction.options.getUser("user");

    if (!usernameInput && !targetUser) {
      return interaction.editReply({
        content: "Provide a username or Discord user."
      });
    }

    const username = usernameInput ||
      findAccountByDiscordId(db, targetUser.id);

    if (!username || !db[username]) {
      return interaction.editReply({
        content: "Account not found."
      });
    }

    return interaction.editReply({
      embeds: [createAccountInfoEmbed(username, db[username])]
    });
  }

  // Staff panel
  if (subcommand === "adminpanel") {
    const channel = interaction.options.getChannel("channel");

    if (!channel?.isTextBased() || !channel.send) {
      return interaction.editReply({
        content: "Select a valid text channel."
      });
    }

    await channel.send({
      embeds: [createStaffPanelEmbed()]
    });

    return interaction.editReply({
      content: `JJSTUDIOS staff panel sent to ${channel}.`
    });
  }

  // API/system check
  if (subcommand === "apicheck") {
    let databaseStatus = "Unavailable";

    try {
      const testDB = readDB();
      databaseStatus = testDB && typeof testDB === "object"
        ? "Readable"
        : "Invalid";
    } catch {}

    const loadedScripts = Object.keys(SCRIPTS).filter(
      (name) => Boolean(SCRIPTS[name])
    );

    const secretConfigured = Boolean(process.env.ACCOUNTS_API_SECRET);

    const embed = new EmbedBuilder()
      .setColor(PINK)
      .setTitle("JJSTUDIOS Account System Check")
      .addFields(
        {
          name: "Database",
          value: databaseStatus,
          inline: true
        },
        {
          name: "Account Endpoint",
          value: "Configured",
          inline: true
        },
        {
          name: "Shared Secret",
          value: secretConfigured ? "Configured" : "Missing",
          inline: true
        },
        {
          name: "Loaded Scripts",
          value: loadedScripts.length
            ? loadedScripts.join(", ")
            : "None",
          inline: false
        },
        {
          name: "Server",
          value: "Online",
          inline: true
        }
      )
      .setFooter({ text: "JJSTUDIOS · System Diagnostics" })
      .setTimestamp();

    return interaction.editReply({
      embeds: [embed]
    });
  }
}

// =====================================================
// INTERACTION HANDLER
// =====================================================

client.on("interactionCreate", async (interaction) => {
  try {
    // ---------------- BUTTONS ----------------

    if (interaction.isButton()) {
      if (interaction.customId.startsWith("jj_accounts_")) {
        const db = readDB();
        const username = findAccountByDiscordId(db, interaction.user.id);

        if (!username || !db[username]) {
          return interaction.reply({
            content: "You do not have a linked JJSTUDIOS account.",
            flags: MessageFlags.Ephemeral
          });
        }

        const account = db[username];
        const action = interaction.customId.slice("jj_accounts_".length);

        if (action === "refresh") {
          return interaction.update({
            embeds: [createCustomerProfileEmbed(interaction.user, account)],
            components: createCustomerProfileComponents()
          });
        }

        if (action === "reset") {
          const lastReset = Number(account.lastHwidReset) || 0;

          if (now() - lastReset < RESET_COOLDOWN) {
            const minutesLeft = Math.ceil(
              (RESET_COOLDOWN - (now() - lastReset)) / 60000
            );

            return interaction.reply({
              content: `Your HWID reset cooldown is active. Try again in ${minutesLeft} minute(s).`,
              flags: MessageFlags.Ephemeral
            });
          }

          account.hwid = null;
          account.hwidLockedAt = null;
          account.lastHwidReset = now();
          account.hwidResetHistory ||= [];

          account.hwidResetHistory.push({
            requestedAt: now(),
            discordId: interaction.user.id
          });

          if (!writeDB(db)) {
            return interaction.reply({
              content: "The reset could not be saved. Please try again.",
              flags: MessageFlags.Ephemeral
            });
          }

          await sendAccountDM(
            account.discordId,
            createHwidResetEmbed({
              ...account,
              username
            })
          );

          return interaction.update({
            embeds: [createCustomerProfileEmbed(interaction.user, account)],
            components: createCustomerProfileComponents()
          });
        }

        const messages = {
          issues: "Known issues are not published yet.",
          updates: "There are no published JJSTUDIOS updates yet.",
          tickets: `You have ${(account.tickets || []).length} ticket(s) on your account.`,
          notifications: "Account notifications are sent by direct message."
        };

        return interaction.reply({
          content: messages[action] || "This action is unavailable.",
          flags: MessageFlags.Ephemeral
        });
      }

      // Main customer panel buttons
      if (interaction.customId.startsWith("jc_")) {
        const action = interaction.customId.slice(3);

        const validActions = [
          "register",
          "key",
          "main",
          "mobilemain",
          "resethwid"
        ];

        if (!validActions.includes(action)) return;

        const member = await getMemberRoles(interaction.user.id);

        const roleMap = {
          register: [MAIN_ACCESS_ROLE, MOBILE_MAIN_ROLE],
          key: [MAIN_ACCESS_ROLE, MOBILE_MAIN_ROLE],
          main: [MAIN_ACCESS_ROLE],
          mobilemain: [MOBILE_MAIN_ROLE],
          resethwid: [MAIN_ACCESS_ROLE, MOBILE_MAIN_ROLE]
        };

        if (!hasAccess(member, roleMap[action])) {
          return interaction.reply({
            content: "You do not have access to use this button.",
            flags: MessageFlags.Ephemeral
          });
        }

        return interaction.showModal(createPanelModal(action));
      }

      return;
    }

    // ---------------- MODALS ----------------

    if (interaction.isModalSubmit()) {
      if (!interaction.customId.startsWith("jc_modal_")) return;

      const action = interaction.customId.slice(9);
      const member = await getMemberRoles(interaction.user.id);

      if (!member) {
        return interaction.reply({
          content: "You are not in the JJSTUDIOS server.",
          flags: MessageFlags.Ephemeral
        });
      }

      const roleMap = {
        register: [MAIN_ACCESS_ROLE, MOBILE_MAIN_ROLE],
        key: [MAIN_ACCESS_ROLE, MOBILE_MAIN_ROLE],
        main: [MAIN_ACCESS_ROLE],
        mobilemain: [MOBILE_MAIN_ROLE],
        resethwid: [MAIN_ACCESS_ROLE, MOBILE_MAIN_ROLE]
      };

      if (!hasAccess(member, roleMap[action] || [])) {
        return interaction.reply({
          content: "You do not have permission to use this action.",
          flags: MessageFlags.Ephemeral
        });
      }

      const username = safeString(
        interaction.fields.getTextInputValue("username")
      );

      const password = interaction.fields.getTextInputValue("password");
      const db = readDB();

      if (action === "register") {
        if (!username || username === "__meta" || db[username]) {
          return interaction.reply({
            content: "That username is unavailable.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (findAccountByDiscordId(db, interaction.user.id)) {
          return interaction.reply({
            content: "You already have a linked account.",
            flags: MessageFlags.Ephemeral
          });
        }

        const products = getGrantedScriptsForMember(member);
        const createdAt = now();

        db[username] = {
          ...createAccountRecord(
            username,
            password,
            interaction.user.id,
            products.length ? products : ["mobile"]
          ),
          createdAt
        };

        if (!writeDB(db)) {
          return interaction.reply({
            content: "Your account could not be saved.",
            flags: MessageFlags.Ephemeral
          });
        }

        await sendAccountLog(
          new EmbedBuilder()
            .setColor(PINK)
            .setTitle("NEW ACCOUNT CREATED")
            .addFields(
              { name: "Username", value: "`" + username + "`", inline: true },
              { name: "Discord User", value: interaction.user.toString(), inline: true },
              { name: "Products", value: getProductNames(db[username].allowedScripts), inline: true },
              { name: "Created", value: `<t:${Math.floor(createdAt / 1000)}:F>`, inline: false }
            )
            .setTimestamp()
        );

        return interaction.reply({
          content:
            "**Account Created!**\n" +
            `**Username:** \`${username}\`\n` +
            `**Key:** \`${db[username].key}\`\n` +
            `**Expires:** ${formatDate(createdAt + KEY_LIFETIME)}\n` +
            `**Products:** ${getProductNames(db[username].allowedScripts)}`,
          flags: MessageFlags.Ephemeral
        });
      }

      const account = db[username];

      if (!account || account.password !== password) {
        return interaction.reply({
          content: "Account not found or incorrect password.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (account.status !== "active" || isExpired(account)) {
        return interaction.reply({
          content: "This account is disabled or expired.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (action === "key") {
        return interaction.reply({
          content: `Your key is: \`${account.key}\``,
          flags: MessageFlags.Ephemeral
        });
      }

      if (action === "resethwid") {
        if (now() - (Number(account.lastHwidReset) || 0) < RESET_COOLDOWN) {
          return interaction.reply({
            content: "Cooldown active. You can reset once every 15 minutes.",
            flags: MessageFlags.Ephemeral
          });
        }

        account.hwid = null;
        account.hwidLockedAt = null;
        account.lastHwidReset = now();
        account.hwidResetHistory ||= [];

        account.hwidResetHistory.push({
          requestedAt: now(),
          discordId: interaction.user.id
        });

        if (!writeDB(db)) {
          return interaction.reply({
            content: "The reset could not be saved.",
            flags: MessageFlags.Ephemeral
          });
        }

        await sendAccountDM(
          account.discordId,
          createHwidResetEmbed({
            ...account,
            username
          })
        );

        return interaction.reply({
          content: "Your HWID has been reset. A confirmation DM was sent if your DMs are open.",
          flags: MessageFlags.Ephemeral
        });
      }

      const inputKey = interaction.fields.getTextInputValue("key").trim();

      if (account.key !== inputKey) {
        return interaction.reply({
          content: "Invalid key.",
          flags: MessageFlags.Ephemeral
        });
      }

      const requestedScript = action === "main" ? "main" : "mobile";

      if (!account.allowedScripts?.includes(requestedScript)) {
        return interaction.reply({
          content: "You do not have access to this product.",
          flags: MessageFlags.Ephemeral
        });
      }

      const loader = createLuaTemplate(
        username,
        inputKey,
        requestedScript,
        requestedScript === "main" ? "JJSTUDIOS Main" : "JJSTUDIOS Mobile"
      );

      return interaction.reply({
        content: "```lua\n" + loader.slice(0, 1800) + "\n```",
        flags: MessageFlags.Ephemeral
      });
    }

    // ---------------- SLASH COMMANDS ----------------

    if (!interaction.isChatInputCommand()) return;

    await interaction.deferReply({
      flags: MessageFlags.Ephemeral
    });

    if (interaction.commandName === "jjstudios") {
      return handleJJStudiosCommand(interaction);
    }

    if (interaction.commandName !== "jamari") return;

    const subcommand = interaction.options.getSubcommand();
    const db = readDB();

    if (["panel", "setpanel"].includes(subcommand)) {
      const member = await getMemberRoles(interaction.user.id);

      if (!isStaff(member)) {
        return interaction.editReply({
          content: "You do not have permission to use this command."
        });
      }

      if (subcommand === "panel") {
        return interaction.editReply(createPanel());
      }

      const channel = interaction.options.getChannel("channel");

      if (!channel?.isTextBased() || !channel.send) {
        return interaction.editReply({
          content: "Select a valid text channel."
        });
      }

      await channel.send(createPanel());

      return interaction.editReply({
        content: `Panel sent to ${channel}.`
      });
    }

    if (["showuserinfo", "accounts", "revoke"].includes(subcommand)) {
      const member = await getMemberRoles(interaction.user.id);

      if (!isStaff(member)) {
        return interaction.editReply({
          content: "You do not have permission to use this command."
        });
      }
    }

    const username = safeString(
      interaction.options.getString("username")
    );

    if (subcommand === "accountstatus") {
      const password = interaction.options.getString("password");
      const account = db[username];

      if (!account || account.password !== password) {
        return interaction.editReply({
          content: "Account not found or incorrect password."
        });
      }

      const expiration = getExpiration(account);
      const daysLeft = expiration
        ? Math.max(0, Math.ceil((expiration - now()) / 86400000))
        : 0;

      return interaction.editReply({
        content:
          `**Account:** \`${username}\`\n` +
          `**Status:** ${account.status || "active"}\n` +
          `**HWID:** ${account.hwid ? "Locked" : "Open"}\n` +
          `**Products:** ${getProductNames(account.allowedScripts || [])}\n` +
          `**Expires:** ${expiration ? formatDate(expiration) : "Unavailable"}\n` +
          `**Days Left:** ${daysLeft}`
      });
    }

    if (subcommand === "changepassword") {
      const oldPassword = interaction.options.getString("old_password");
      const newPassword = interaction.options.getString("new_password");
      const account = db[username];

      if (!account || account.password !== oldPassword) {
        return interaction.editReply({
          content: "Account not found or incorrect password."
        });
      }

      account.password = newPassword;

      if (!writeDB(db)) {
        return interaction.editReply({
          content: "Could not save the new password."
        });
      }

      return interaction.editReply({
        content: "Password changed successfully."
      });
    }

    if (subcommand === "showuserinfo") {
      const lookup = safeString(
        interaction.options.getString("lookup")
      );

      if (!lookup || !db[lookup]) {
        return interaction.editReply({
          content: "Account not found."
        });
      }

      return interaction.editReply({
        embeds: [createAccountInfoEmbed(lookup, db[lookup])]
      });
    }

    if (subcommand === "accounts") {
      const names = getAccountKeys(db);

      if (!names.length) {
        return interaction.editReply({
          content: "No accounts found."
        });
      }

      const lines = names.map((name) => {
        const account = db[name];

        return (
          `• **${name}** — ${account.status || "active"} — ` +
          `${getProductNames(account.allowedScripts || [])} — ` +
          `${account.hwid ? "HWID Locked" : "HWID Open"}`
        );
      });

      const output = lines.join("\n");

      return interaction.editReply({
        content: output.slice(0, 1900)
      });
    }

    if (subcommand === "revoke") {
      const targetUser = interaction.options.getUser("user");
      const username = findAccountByDiscordId(db, targetUser.id);

      if (!username) {
        return interaction.editReply({
          content: "No linked account found."
        });
      }

      db[username].status = "disabled";
      db[username].allowedScripts = [];

      if (!writeDB(db)) {
        return interaction.editReply({
          content: "Could not save the account change."
        });
      }

      return interaction.editReply({
        content: `Disabled the account for ${targetUser}. Use \`/jjstudios revoke\` to delete an account completely.`
      });
    }

    return interaction.editReply({
      content: "Unknown command."
    });
  } catch (error) {
    console.error("[INTERACTION ERROR]", error);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          content: "Something went wrong. Check the bot logs."
        });
      } else {
        await interaction.reply({
          content: "Something went wrong. Check the bot logs.",
          flags: MessageFlags.Ephemeral
        });
      }
    } catch {}
  }
});

// =====================================================
// AUTOMATIC ROLE SYNC
// =====================================================

client.on("guildMemberUpdate", async (oldMember, newMember) => {
  try {
    const db = readDB();
    const username = findAccountByDiscordId(db, newMember.id);

    if (!username || !db[username]) return;

    // Keep deleted/disabled accounts from regaining products.
    if (db[username].status !== "active") return;

    const oldRoles = oldMember.roles.cache;
    const newRoles = newMember.roles.cache;

    const changed =
      oldRoles.size !== newRoles.size ||
      ![...oldRoles.keys()].every((roleId) => newRoles.has(roleId));

    if (!changed) return;

    db[username].allowedScripts = getGrantedScriptsForMember(newMember);
    writeDB(db);
  } catch (error) {
    console.error("[AUTO ROLE SYNC ERROR]", error);
  }
});

// =====================================================
// PRIVATE TICKET BOT ACCOUNT ENDPOINT
// =====================================================

app.get("/api/account/:discordId", (req, res) => {
  const secret = process.env.ACCOUNTS_API_SECRET;
  const providedSecret = req.get("x-api-secret");

  if (!secret || !providedSecret || providedSecret !== secret) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized"
    });
  }

  const discordId = String(req.params.discordId || "");

  if (!/^\d{17,20}$/.test(discordId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid Discord ID"
    });
  }

  try {
    const db = readDB();
    const username = findAccountByDiscordId(db, discordId);

    if (!username || !db[username]) {
      return res.status(404).json({
        success: false,
        message: "No linked account found"
      });
    }

    const account = db[username];
    const keyCreatedAt = Number(account.keyCreatedAt) || null;

    res.set("Cache-Control", "no-store");

    return res.json({
      success: true,
      account: {
        username,
        status: account.status || "active",
        scripts: Array.isArray(account.allowedScripts)
          ? account.allowedScripts
          : [],
        hwidLocked: Boolean(account.hwid),
        executions: Number(account.executions) || 0,
        keyCreatedAt,
        expiresAt: keyCreatedAt
          ? keyCreatedAt + KEY_LIFETIME
          : null
      }
    });
  } catch (error) {
    console.error("[ACCOUNT ENDPOINT ERROR]", error);

    return res.status(500).json({
      success: false,
      message: "Unable to retrieve account"
    });
  }
});

// =====================================================
// EXPRESS SERVER
// =====================================================

app.listen(PORT, () => {
  console.log(`[EXPRESS] JJSTUDIOS service listening on port ${PORT}`);
});

// =====================================================
// KEEP ALIVE
// =====================================================

const KEEP_ALIVE_INTERVAL = 5 * 60 * 1000;

function startKeepAlive() {
  const url =
    process.env.RENDER_EXTERNAL_URL ||
    `http://localhost:${PORT}`;

  const protocol = url.startsWith("https") ? https : http;

  setInterval(() => {
    protocol.get(url, { timeout: 5000 }, (response) => {
      response.resume();
    }).on("error", (error) => {
      console.log("[KEEP ALIVE]", error.message);
    });
  }, KEEP_ALIVE_INTERVAL);
}

startKeepAlive();

// =====================================================
// DM COMMANDS
// =====================================================

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot || message.guild) return;

    const content = (message.content || "").trim();

    if (!content.toLowerCase().startsWith("!jamari")) return;

    const parts = content.split(/\s+/);
    const subcommand = (parts[1] || "").toLowerCase();
    const db = readDB();

    if (!subcommand || subcommand === "help") {
      return message.reply(
        "**Jamari DM Commands**\n" +
        "`!jamari accountstatus <username> <password>`\n" +
        "`!jamari changepassword <username> <oldpass> <newpass>`\n" +
        "`!jamari key <username> <password>`"
      );
    }

    const username = safeString(parts[2]);
    const password = parts[3];
    const account = username ? db[username] : null;

    if (!account || account.password !== password) {
      return message.reply("Account not found or incorrect password.");
    }

    if (account.status !== "active" || isExpired(account)) {
      return message.reply("This account is disabled or expired.");
    }

    if (subcommand === "accountstatus") {
      const expiration = getExpiration(account);

      return message.reply(
        `**Account:** \`${username}\`\n` +
        `**Status:** ${account.status}\n` +
        `**Products:** ${getProductNames(account.allowedScripts || [])}\n` +
        `**HWID:** ${account.hwid ? "Locked" : "Open"}\n` +
        `**Expires:** ${expiration ? formatDate(expiration) : "Unavailable"}`
      );
    }

    if (subcommand === "key") {
      return message.reply(`Your key is: \`${account.key}\``);
    }

    if (subcommand === "changepassword") {
      const newPassword = parts[4];

      if (!newPassword) {
        return message.reply(
          "Usage: `!jamari changepassword <username> <oldpass> <newpass>`"
        );
      }

      account.password = newPassword;

      if (!writeDB(db)) {
        return message.reply("Could not save the new password.");
      }

      return message.reply("Password changed successfully.");
    }

    return message.reply("Unknown command. Type `!jamari help`.");
  } catch (error) {
    console.error("[DM COMMAND ERROR]", error);

    try {
      await message.reply("Something went wrong.");
    } catch {}
  }
});

// =====================================================
// EXPIRATION NOTIFICATIONS
// =====================================================

let expirationNoticeCheckRunning = false;

async function checkAccountExpirationNotices() {
  if (expirationNoticeCheckRunning || !client.isReady()) return;

  expirationNoticeCheckRunning = true;

  try {
    const db = readDB();
    let changed = false;

    for (const username of getAccountKeys(db)) {
      const account = db[username];

      if (
        !account ||
        account.status !== "active" ||
        !account.discordId
      ) {
        continue;
      }

      const expiration = getExpiration(account);

      if (!expiration) continue;

      const remaining = expiration - now();

      if (remaining <= 0) continue;

      account.expirationNotices ||= {};

      let noticeKey = null;
      let noticeName = null;

      if (
        remaining <= EXPIRATION_NOTICE_15_HOURS &&
        !account.expirationNotices.fifteenHoursSentAt
      ) {
        noticeKey = "fifteenHoursSentAt";
        noticeName = "15-hour reminder";
      } else if (
        remaining <= EXPIRATION_NOTICE_3_DAYS &&
        !account.expirationNotices.threeDaysSentAt
      ) {
        noticeKey = "threeDaysSentAt";
        noticeName = "3-day reminder";
      }

      if (!noticeKey) continue;

      const embed = createNotificationEmbed(
        "Your Access Is Expiring Soon",
        `Your JJSTUDIOS access is getting close to its expiration.\n\nThis is your ${noticeName}.`
      ).addFields(
        {
          name: "Expires",
          value: `<t:${Math.floor(expiration / 1000)}:F> · <t:${Math.floor(expiration / 1000)}:R>`,
          inline: false
        },
        {
          name: "Products",
          value: getProductNames(account.allowedScripts || []),
          inline: false
        }
      );

      const result = await sendAccountDM(account.discordId, embed);

      if (result.sent) {
        account.expirationNotices[noticeKey] = now();
        changed = true;
      }
    }

    if (changed) writeDB(db);
  } catch (error) {
    console.error("[EXPIRATION CHECK ERROR]", error);
  } finally {
    expirationNoticeCheckRunning = false;
  }
}

// =====================================================
// BOT READY + COMMAND REGISTRATION
// =====================================================

client.once("ready", async () => {
  console.log(`[BOT ONLINE] Logged in as ${client.user.tag}`);

  checkAccountExpirationNotices();

  setInterval(
    checkAccountExpirationNotices,
    EXPIRATION_NOTICE_CHECK_INTERVAL
  );

  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

  try {
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: [] }
    );

    console.log("[COMMANDS] Cleared old guild commands.");
  } catch (error) {
    console.error("[COMMANDS] Could not clear guild commands:", error.message);
  }

  try {
    const registered = await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commandLayouts }
    );

    console.log(
      `[COMMANDS] Registered ${registered.length} global commands.`
    );
  } catch (error) {
    console.error("[COMMANDS] Registration failed:", error);

    if (error.rawError) {
      console.error(JSON.stringify(error.rawError, null, 2));
    }
  }
});

// =====================================================
// LOGIN
// =====================================================

console.log("[LOGIN] Starting JJSTUDIOS bot...");

client.login(BOT_TOKEN).catch((error) => {
  console.error("[LOGIN FAILED]", error);
});
