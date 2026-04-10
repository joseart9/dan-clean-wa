const { Client, RemoteAuth, LocalAuth } = require("whatsapp-web.js");
const { MongoStore } = require("wwebjs-mongo");
const mongoose = require("mongoose");
const qrcode = require("qrcode");
const { execSync } = require("child_process");
const fs = require("fs").promises;
const path = require("path");

const MONGODB_URI = process.env.MONGODB_URI;

const CHROME_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (() => {
    try {
      return require("puppeteer").executablePath();
    } catch {
      return "/usr/bin/chromium";
    }
  })();

const PUPPETEER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-accelerated-2d-canvas",
  "--no-first-run",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-translate",
  "--metrics-recording-only",
  "--mute-audio",
  "--no-default-browser-check",
  "--disable-hang-monitor",
  "--disable-prompt-on-repost",
  "--disable-client-side-phishing-detection",
  "--disable-component-update",
  "--disable-domain-reliability",
];

let client = null;
let store = null;
let qrCodeData = null;
let clientReady = false;
let isReconnecting = false;
let initAttempts = 0;
let reconnectTimer = null;
let healthInterval = null;

const MAX_INIT_ATTEMPTS = 3;
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000;

function killZombieChrome() {
  if (process.platform === "win32") return;
  try {
    execSync("pkill -9 -f '(chromium|chrome)( |$)' 2>/dev/null || true", {
      stdio: "ignore",
      timeout: 5000,
    });
  } catch {
    // Ignore — no matching processes or pkill not available
  }
}

function createAuthStrategy() {
  if (store) {
    return new RemoteAuth({
      store,
      clientId: "dan-clean-wa",
      backupSyncIntervalMs: 300000,
    });
  }
  return new LocalAuth({ dataPath: "./.wwebjs_auth" });
}

function createClient() {
  const newClient = new Client({
    authStrategy: createAuthStrategy(),
    puppeteer: {
      headless: true,
      executablePath: CHROME_PATH,
      args: PUPPETEER_ARGS,
      timeout: 120000,
    },
  });

  newClient.on("qr", async (qr) => {
    console.log("QR Code received");
    try {
      qrCodeData = await qrcode.toDataURL(qr);
    } catch (err) {
      console.error("Error generating QR code:", err.message);
    }
  });

  newClient.on("ready", () => {
    console.log("✓ WhatsApp client is ready!");
    clientReady = true;
    isReconnecting = false;
    qrCodeData = null;
    initAttempts = 0;
  });

  newClient.on("authenticated", () => {
    console.log("✓ Client authenticated");
  });

  newClient.on("remote_session_saved", () => {
    console.log("✓ Session backed up to MongoDB");
  });

  newClient.on("auth_failure", (msg) => {
    console.error("✗ Authentication failure:", msg);
    clientReady = false;
    isReconnecting = false;
    qrCodeData = null;
  });

  newClient.on("disconnected", (reason) => {
    console.log("Client disconnected:", reason);
    clientReady = false;
    qrCodeData = null;
    scheduleReconnect();
  });

  newClient.on("loading_screen", (percent, message) => {
    console.log(`Loading: ${percent}% - ${message}`);
  });

  newClient.on("change_state", (state) => {
    console.log("Connection state:", state);
  });

  return newClient;
}

async function initializeClient() {
  isReconnecting = false;
  killZombieChrome();
  await new Promise((r) => setTimeout(r, 1000));

  try {
    client = createClient();
    await client.initialize();
  } catch (err) {
    initAttempts++;
    console.error(
      `Error initializing (attempt ${initAttempts}/${MAX_INIT_ATTEMPTS}):`,
      err.message
    );
    killZombieChrome();

    if (initAttempts < MAX_INIT_ATTEMPTS) {
      const delay = 5000 * Math.pow(2, initAttempts - 1);
      console.log(`Retrying in ${delay / 1000}s...`);
      setTimeout(initializeClient, delay);
    } else {
      console.error("Failed to initialize after all attempts.");
      initAttempts = 0;
    }
  }
}

function scheduleReconnect() {
  if (isReconnecting || reconnectTimer) return;

  isReconnecting = true;
  console.log("Scheduling reconnect in 5s...");

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    initAttempts = 0;

    if (client) {
      try {
        await client.destroy();
      } catch {
        // Old client may already be dead
      }
      client = null;
    }

    killZombieChrome();
    await new Promise((r) => setTimeout(r, 2000));
    initializeClient();
  }, 5000);
}

function healthCheck() {
  if (!clientReady || isReconnecting || !client) return;

  client
    .getState()
    .then((state) => {
      if (state !== "CONNECTED") {
        console.log(`Health check: state=${state}, reconnecting...`);
        scheduleReconnect();
      }
    })
    .catch((err) => {
      console.error("Health check error:", err.message);
      if (!isReconnecting) scheduleReconnect();
    });
}

async function initialize() {
  if (MONGODB_URI) {
    await mongoose.connect(MONGODB_URI, { dbName: "dan-clean-wa" });
    console.log("✓ Connected to MongoDB");
    store = new MongoStore({ mongoose });
    console.log("✓ MongoStore ready");
  } else {
    console.warn(
      "⚠ MONGODB_URI not set — using LocalAuth (sessions won't survive restarts)"
    );
  }

  await initializeClient();
  healthInterval = setInterval(healthCheck, HEALTH_CHECK_INTERVAL);
}

function getClient() {
  return client;
}

function getStatus() {
  return {
    ready: clientReady,
    qrCode: qrCodeData,
    reconnecting: isReconnecting,
  };
}

async function reconnect() {
  if (isReconnecting) {
    throw new Error("Reconnection already in progress");
  }
  scheduleReconnect();
}

async function logout() {
  clientReady = false;
  isReconnecting = true;
  qrCodeData = null;

  if (client) {
    try {
      await client.logout();
    } catch (err) {
      console.log("Error during logout:", err.message);
      try {
        await client.destroy();
      } catch {
        // Ignore
      }
    }
    client = null;
  }

  killZombieChrome();

  try {
    await fs.rm(path.join(process.cwd(), ".wwebjs_auth"), {
      recursive: true,
      force: true,
    });
  } catch {
    // Ignore
  }

  initAttempts = 0;
  isReconnecting = false;
  setTimeout(initializeClient, 2000);
}

async function shutdown() {
  if (healthInterval) clearInterval(healthInterval);
  if (reconnectTimer) clearTimeout(reconnectTimer);

  if (client) {
    try {
      await client.destroy();
    } catch {
      // Ignore
    }
  }

  killZombieChrome();

  if (mongoose.connection.readyState === 1) {
    await mongoose.disconnect();
  }
}

module.exports = {
  initialize,
  getClient,
  getStatus,
  reconnect,
  logout,
  shutdown,
};
