// Load environment variables from .env file
require("dotenv").config();

const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const path = require("path");
const puppeteer = require("puppeteer");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const fs = require("fs").promises;

const app = express();
const PORT = process.env.PORT || 4000;
const AUTH_SECRET = process.env.AUTH_SECRET;

if (!AUTH_SECRET) {
  console.warn(
    "WARNING: AUTH_SECRET environment variable is not set. Authentication will be disabled."
  );
  console.warn(
    "WARNING: This should only be used for local development. Set AUTH_SECRET in production!"
  );
} else {
  console.log("✓ Authentication enabled with AUTH_SECRET");
}

// CORS configuration
const allowedOrigins = [
  "https://danclean.vercel.app",
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps, Postman, etc.)
      if (!origin) return callback(null, true);

      // Check if origin matches allowed patterns
      const isAllowed = allowedOrigins.some((allowedOrigin) => {
        if (typeof allowedOrigin === "string") {
          return origin === allowedOrigin;
        } else if (allowedOrigin instanceof RegExp) {
          return allowedOrigin.test(origin);
        }
        return false;
      });

      if (isAllowed) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Middleware
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Authentication middleware
const authenticate = (req, res, next) => {
  // Skip auth if AUTH_SECRET is not set (development mode)
  if (!AUTH_SECRET) {
    return next();
  }

  try {
    // Try to get token from cookie first, then from Authorization header
    const token =
      req.cookies.token || req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({
        status: "error",
        message: "Authentication required. No token provided.",
      });
    }

    // Verify JWT token
    const decoded = jwt.verify(token, AUTH_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        status: "error",
        message: "Token expired. Please login again.",
      });
    } else if (error.name === "JsonWebTokenError") {
      return res.status(401).json({
        status: "error",
        message: "Invalid token. Please login again.",
      });
    }
    return res.status(401).json({
      status: "error",
      message: "Authentication failed.",
    });
  }
};

// Initialize WhatsApp client
// Determine if we're on Windows or Linux (for Railway)
const isWindows = process.platform === "win32";
const puppeteerArgs = isWindows
  ? [
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--disable-gpu",
      "--disable-software-rasterizer",
    ]
  : [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu",
    ];

// Get Chromium executable path from puppeteer
const chromiumExecutablePath = puppeteer.executablePath();

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: "./.wwebjs_auth",
  }),
  puppeteer: {
    headless: true,
    executablePath: chromiumExecutablePath,
    args: puppeteerArgs,
    timeout: 60000,
  },
});

let qrCodeData = null;
let isReady = false;
let clientReady = false;
let isReconnecting = false;

// Event handlers
client.on("qr", async (qr) => {
  console.log("QR Code received, generating...");
  try {
    // Generate QR code as data URL
    qrCodeData = await qrcode.toDataURL(qr);
    console.log("QR Code generated successfully");
  } catch (err) {
    console.error("Error generating QR code:", err);
  }
});

client.on("ready", () => {
  console.log("WhatsApp client is ready!");
  isReady = true;
  clientReady = true;
  isReconnecting = false;
  qrCodeData = null; // Clear QR code once ready
});

client.on("authenticated", () => {
  console.log("Client authenticated - Session saved");
});

client.on("auth_failure", (msg) => {
  console.error("Authentication failure:", msg);
  isReady = false;
  clientReady = false;
  isReconnecting = false;
  qrCodeData = null;
});

client.on("disconnected", (reason) => {
  console.log("Client disconnected:", reason);
  isReady = false;
  clientReady = false;
  isReconnecting = false;
  qrCodeData = null;

  // Auto-reconnect on unexpected disconnection
  if (reason === "NAVIGATION" || reason === "CONNECTION_CLOSED") {
    console.log("Attempting to reconnect...");
    reconnectClient();
  }
});

// Remote session saved event - handles session refresh
client.on("remote_session_saved", () => {
  console.log("Remote session saved - Session refreshed successfully");
});

// Handle loading screen events
client.on("loading_screen", (percent, message) => {
  console.log(`Loading: ${percent}% - ${message}`);
});

// Initialize client with retry logic
let initializationAttempts = 0;
const maxInitAttempts = 3;

const initializeClient = async () => {
  try {
    isReconnecting = false;
    await client.initialize();
  } catch (err) {
    initializationAttempts++;
    console.error(
      `Error initializing client (attempt ${initializationAttempts}/${maxInitAttempts}):`,
      err.message
    );

    if (initializationAttempts < maxInitAttempts) {
      console.log(`Retrying initialization in 5 seconds...`);
      setTimeout(() => {
        initializeClient();
      }, 5000);
    } else {
      console.error(
        "Failed to initialize client after multiple attempts. Please check your system configuration."
      );
    }
  }
};

// Reconnect client function
const reconnectClient = async () => {
  if (isReconnecting) {
    console.log("Reconnection already in progress...");
    return;
  }

  isReconnecting = true;
  initializationAttempts = 0;

  try {
    console.log("Destroying existing client...");
    await client.destroy();
  } catch (err) {
    console.log(
      "Error destroying client (may not be initialized):",
      err.message
    );
  }

  // Wait a bit before reinitializing
  setTimeout(() => {
    console.log("Reinitializing client...");
    initializeClient();
  }, 2000);
};

// Check session health periodically
setInterval(() => {
  if (clientReady && !isReconnecting) {
    // Check if client is still connected
    client
      .getState()
      .then((state) => {
        if (state === "CONNECTED") {
          // Session is healthy
          return;
        } else {
          console.log(
            `Session state changed to: ${state}. Attempting to reconnect...`
          );
          reconnectClient();
        }
      })
      .catch((err) => {
        console.error("Error checking session state:", err.message);
        // If we can't check state, try to reconnect
        if (!isReconnecting) {
          reconnectClient();
        }
      });
  }
}, 60000); // Check every minute

initializeClient();

// Routes

// Health check endpoint (protected)
app.get("/health", authenticate, async (req, res) => {
  let sessionState = "UNKNOWN";
  try {
    if (clientReady) {
      sessionState = await client.getState();
    }
  } catch (err) {
    sessionState = "ERROR";
  }

  const status = {
    status: clientReady ? "ok" : "error",
    whatsapp: {
      ready: clientReady,
      authenticated: clientReady,
      hasQr: qrCodeData !== null,
      state: sessionState,
      reconnecting: isReconnecting,
    },
    timestamp: new Date().toISOString(),
  };

  if (clientReady && sessionState === "CONNECTED") {
    res.status(200).json(status);
  } else if (qrCodeData) {
    res.status(200).json({
      ...status,
      message: "Waiting for QR code scan",
    });
  } else if (isReconnecting) {
    res.status(503).json({
      ...status,
      message: "WhatsApp client is reconnecting",
    });
  } else {
    res.status(503).json({
      ...status,
      message: "WhatsApp client not initialized or disconnected",
    });
  }
});

// Connect endpoint - returns QR code (protected)
app.get("/connect", authenticate, async (req, res) => {
  try {
    if (clientReady) {
      return res.status(200).json({
        status: "connected",
        message: "WhatsApp is already connected and ready",
      });
    }

    if (qrCodeData) {
      return res.status(200).json({
        status: "qr_ready",
        qr: qrCodeData,
        message: "Scan this QR code with WhatsApp",
      });
    }

    // If no QR code yet, wait a bit and check again
    // In production, you might want to implement a polling mechanism
    res.status(202).json({
      status: "generating",
      message: "QR code is being generated, please try again in a few seconds",
    });
  } catch (error) {
    console.error("Error in /connect endpoint:", error);
    res.status(500).json({
      status: "error",
      message: "Failed to generate QR code",
      error: error.message,
    });
  }
});

// Send message endpoint (protected)
app.post("/send-msg", authenticate, async (req, res) => {
  let whatsappNumber = null;
  try {
    const { to, message } = req.body;

    // Validation
    if (!to || !message) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields: to and message are required",
      });
    }

    if (!clientReady) {
      // If client is not ready but we're reconnecting, let user know
      if (isReconnecting) {
        return res.status(503).json({
          status: "error",
          message:
            "WhatsApp client is reconnecting. Please try again in a few seconds.",
        });
      }
      return res.status(503).json({
        status: "error",
        message:
          "WhatsApp client is not ready. Please connect first using /connect endpoint",
      });
    }

    // Format phone number for WhatsApp
    // Remove all non-digit characters (including +, spaces, dashes, etc.)
    let phoneNumber = to.replace(/\D/g, "");

    // Remove @c.us if already present
    phoneNumber = phoneNumber.replace("@c.us", "");

    // Ensure phone number is not empty
    if (!phoneNumber || phoneNumber.length < 10) {
      return res.status(400).json({
        status: "error",
        message: "Invalid phone number format",
      });
    }

    // Add @c.us suffix for WhatsApp format
    whatsappNumber = phoneNumber + "@c.us";

    // Try to get the number ID first (this validates the number is on WhatsApp)
    // If this fails, we'll still try to send, but with better error handling
    let numberId = null;
    try {
      numberId = await client.getNumberId(whatsappNumber);
      if (numberId) {
        // Use the validated number ID (more reliable)
        whatsappNumber = numberId._serialized;
      }
    } catch (validationError) {
      // If validation fails, we'll still try to send with the original format
      // Some numbers might work even if validation fails
      console.log(
        "Number validation failed, will try sending with original format:",
        validationError.message
      );
    }

    // Send message
    const result = await client.sendMessage(whatsappNumber, message);

    res.status(200).json({
      status: "success",
      message: "Message sent successfully",
      messageId: result.id._serialized,
      to: whatsappNumber,
    });
  } catch (error) {
    console.error("Error sending message:", error);
    console.error("Error details:", {
      message: error.message,
      stack: error.stack,
      phoneNumber: whatsappNumber || "unknown",
    });

    // Provide more specific error messages
    let errorMessage = "Failed to send message";
    const errorMsg = error.message || "";

    // Check for session-related errors
    if (
      errorMsg.includes("Session closed") ||
      errorMsg.includes("Target closed") ||
      errorMsg.includes("Protocol error")
    ) {
      // Session expired or connection lost - trigger reconnection
      console.log("Session error detected, triggering reconnection...");
      if (!isReconnecting) {
        reconnectClient();
      }
      errorMessage =
        "WhatsApp session expired. Reconnecting automatically. Please try again in a few seconds.";
    } else if (errorMsg.includes("No LID for user")) {
      errorMessage =
        "The phone number is not registered on WhatsApp or cannot be found. Please verify the number is correct and has WhatsApp installed.";
    } else if (errorMsg && errorMsg !== "t") {
      errorMessage = errorMsg;
    } else if (errorMsg === "t") {
      errorMessage =
        "Invalid phone number or contact not found. Please ensure the phone number is correct and includes the country code.";
    }

    res.status(500).json({
      status: "error",
      message: errorMessage,
      error: error.message || "Unknown error",
      phoneNumber: whatsappNumber || "unknown",
    });
  }
});

// Reconnect endpoint (protected) - manually trigger reconnection
app.post("/reconnect", authenticate, async (req, res) => {
  try {
    if (isReconnecting) {
      return res.status(409).json({
        status: "error",
        message: "Reconnection already in progress",
      });
    }

    console.log("Manual reconnection triggered by user");
    reconnectClient();

    res.status(200).json({
      status: "success",
      message:
        "Reconnection initiated. Please check /health endpoint for status.",
    });
  } catch (error) {
    console.error("Error in /reconnect endpoint:", error);
    res.status(500).json({
      status: "error",
      message: "Failed to initiate reconnection",
      error: error.message,
    });
  }
});

// Logout endpoint (protected) - destroys session and clears auth data
app.post("/logout", authenticate, async (req, res) => {
  try {
    console.log("Logout requested - destroying WhatsApp session...");

    // Reset state variables
    isReconnecting = true;
    clientReady = false;
    isReady = false;
    qrCodeData = null;

    // Destroy the client
    try {
      await client.destroy();
      console.log("WhatsApp client destroyed");
    } catch (destroyError) {
      console.log(
        "Error destroying client (may not be initialized):",
        destroyError.message
      );
    }

    // Delete session data directory
    const sessionPath = path.join(process.cwd(), ".wwebjs_auth");
    try {
      await fs.rm(sessionPath, { recursive: true, force: true });
      console.log("Session data deleted successfully");
    } catch (deleteError) {
      // If directory doesn't exist, that's fine
      if (deleteError.code !== "ENOENT") {
        console.error("Error deleting session data:", deleteError.message);
      }
    }

    // Reset initialization attempts
    initializationAttempts = 0;

    // Reinitialize client to generate new QR code
    setTimeout(() => {
      console.log("Reinitializing client for new session...");
      isReconnecting = false;
      initializeClient();
    }, 2000);

    res.status(200).json({
      status: "success",
      message:
        "Logged out successfully. Session cleared. Please scan QR code again via /connect endpoint.",
    });
  } catch (error) {
    console.error("Error in /logout endpoint:", error);
    res.status(500).json({
      status: "error",
      message: "Failed to logout",
      error: error.message,
    });
  }
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    message: "WhatsApp Web API",
    endpoints: {
      health: "GET /health - Check WhatsApp connection status (protected)",
      connect: "GET /connect - Get QR code for WhatsApp connection (protected)",
      sendMsg:
        "POST /send-msg - Send a WhatsApp message (protected, body: { to: string, message: string })",
      reconnect:
        "POST /reconnect - Manually trigger WhatsApp reconnection (protected)",
      logout:
        "POST /logout - Destroy WhatsApp session and clear auth data (protected)",
    },
    authentication: AUTH_SECRET ? "Enabled" : "Disabled (development mode)",
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Connect: http://localhost:${PORT}/connect`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, closing server...");
  client.destroy();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received, closing server...");
  client.destroy();
  process.exit(0);
});
