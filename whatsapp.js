const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const { execSync } = require("child_process");
const fs = require("fs").promises;
const path = require("path");

const SESSION_DATA_PATH =
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  process.env.WWEBJS_DATA_PATH ||
  path.join(process.cwd(), ".wwebjs_auth");

const CLIENT_ID = "dan-clean-wa";

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
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--disable-ipc-flooding-protection",
  "--disable-breakpad",
  "--disable-features=TranslateUI,BlinkGenPropertyTrees,AudioServiceOutOfProcess",
];

let client = null;
let qrCodeData = null;
let clientReady = false;
let isReconnecting = false;
let initAttempts = 0;
let reconnectTimer = null;
let healthInterval = null;
let consecutiveHealthFailures = 0;

const MAX_INIT_ATTEMPTS = 3;
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000;
const HEALTH_FAILURE_THRESHOLD = 3;

const TERMINAL_STATES = new Set([
  "UNPAIRED",
  "UNPAIRED_IDLE",
  "DEPRECATED_VERSION",
  "TOS_BLOCK",
  "SMB_TOS_BLOCK",
]);

function killZombieChrome() {
  if (process.platform === "win32") return;
  try {
    execSync(
      "pgrep -f '(chromium|chrome) ' | xargs -r kill -9 2>/dev/null || true",
      { stdio: "ignore", timeout: 5000 }
    );
  } catch {
    // No matching processes or command not available
  }
}

async function ensureSessionDir() {
  try {
    await fs.mkdir(SESSION_DATA_PATH, { recursive: true });
  } catch (err) {
    console.error(
      `Failed to ensure session dir at ${SESSION_DATA_PATH}:`,
      err.message
    );
  }
}

// Chromium writes SingletonLock/Cookie/Socket files into the user-data-dir
// containing the host PID + hostname. On a containerized redeploy the
// hostname changes, so Chromium refuses to reuse the profile. Since this
// service only ever runs one Chromium against this volume, it is safe to
// clear stale locks at startup.
async function cleanupSessionLocks() {
  const sessionDir = path.join(SESSION_DATA_PATH, `session-${CLIENT_ID}`);
  const lockFiles = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
  let removed = 0;

  await Promise.all(
    lockFiles.map(async (file) => {
      try {
        await fs.unlink(path.join(sessionDir, file));
        removed++;
      } catch (err) {
        if (err.code !== "ENOENT") {
          console.warn(`Could not remove ${file}: ${err.message}`);
        }
      }
    })
  );

  if (removed > 0) {
    console.log(`Cleared ${removed} stale Chromium lock file(s)`);
  }
}

function createClient() {
  const newClient = new Client({
    authStrategy: new LocalAuth({
      clientId: CLIENT_ID,
      dataPath: SESSION_DATA_PATH,
    }),
    puppeteer: {
      headless: true,
      executablePath: CHROME_PATH,
      args: PUPPETEER_ARGS,
      timeout: 180000,
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
    consecutiveHealthFailures = 0;
  });

  newClient.on("authenticated", () => {
    console.log("✓ Client authenticated (session saved locally)");
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
    if (TERMINAL_STATES.has(state) && clientReady) {
      console.log(`Terminal state detected: ${state}, reconnecting...`);
      clientReady = false;
      scheduleReconnect();
    }
  });

  return newClient;
}

async function initializeClient() {
  isReconnecting = false;
  killZombieChrome();
  await cleanupSessionLocks();
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
  consecutiveHealthFailures = 0;
  console.log("Scheduling reconnect in 10s...");

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
    await new Promise((r) => setTimeout(r, 3000));
    initializeClient();
  }, 10000);
}

function healthCheck() {
  if (!clientReady || isReconnecting || !client) return;

  client
    .getState()
    .then((state) => {
      if (state === "CONNECTED") {
        if (consecutiveHealthFailures > 0) {
          console.log(
            `Health check recovered after ${consecutiveHealthFailures} failure(s)`
          );
        }
        consecutiveHealthFailures = 0;
        return;
      }

      consecutiveHealthFailures++;
      console.log(
        `Health check: state=${state} (${consecutiveHealthFailures}/${HEALTH_FAILURE_THRESHOLD})`
      );

      if (TERMINAL_STATES.has(state)) {
        consecutiveHealthFailures = 0;
        scheduleReconnect();
      } else if (consecutiveHealthFailures >= HEALTH_FAILURE_THRESHOLD) {
        console.log("Health check threshold reached, reconnecting...");
        consecutiveHealthFailures = 0;
        scheduleReconnect();
      }
    })
    .catch((err) => {
      consecutiveHealthFailures++;
      console.error(
        `Health check error (${consecutiveHealthFailures}/${HEALTH_FAILURE_THRESHOLD}):`,
        err.message
      );

      if (
        consecutiveHealthFailures >= HEALTH_FAILURE_THRESHOLD &&
        !isReconnecting
      ) {
        console.log("Health check threshold reached, reconnecting...");
        consecutiveHealthFailures = 0;
        scheduleReconnect();
      }
    });
}

async function initialize() {
  console.log(`✓ Session data path: ${SESSION_DATA_PATH}`);
  if (
    !process.env.RAILWAY_VOLUME_MOUNT_PATH &&
    process.env.RAILWAY_ENVIRONMENT
  ) {
    console.warn(
      "⚠ Running on Railway WITHOUT a persistent volume mounted. " +
        "Sessions will NOT survive deploys/restarts. " +
        "Mount a volume at /app/.wwebjs_auth to fix this."
    );
  }

  await ensureSessionDir();
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
    await fs.rm(SESSION_DATA_PATH, { recursive: true, force: true });
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
}

module.exports = {
  initialize,
  getClient,
  getStatus,
  reconnect,
  logout,
  shutdown,
};
