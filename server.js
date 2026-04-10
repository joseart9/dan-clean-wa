require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const whatsapp = require("./whatsapp");

const app = express();
const PORT = process.env.PORT || 4000;
const AUTH_SECRET = process.env.AUTH_SECRET;

if (!AUTH_SECRET) {
  console.warn("⚠ AUTH_SECRET not set — authentication disabled (dev mode)");
} else {
  console.log("✓ Authentication enabled");
}

const allowedOrigins = [
  "https://danclean.vercel.app",
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      const isAllowed = allowedOrigins.some((o) =>
        typeof o === "string" ? origin === o : o.test(origin)
      );
      callback(isAllowed ? null : new Error("Not allowed by CORS"), isAllowed);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "token"],
  })
);

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const authenticate = (req, res, next) => {
  if (!AUTH_SECRET) return next();

  try {
    const token =
      req.headers.token ||
      req.cookies.token ||
      req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({
        status: "error",
        message: "Authentication required. No token provided.",
      });
    }

    req.user = jwt.verify(token, AUTH_SECRET);
    next();
  } catch (error) {
    const message =
      error.name === "TokenExpiredError"
        ? "Token expired. Please login again."
        : error.name === "JsonWebTokenError"
          ? "Invalid token. Please login again."
          : "Authentication failed.";
    return res.status(401).json({ status: "error", message });
  }
};

// --- Routes ---

app.get("/health", authenticate, async (req, res) => {
  const status = whatsapp.getStatus();
  let sessionState = "UNKNOWN";

  try {
    const client = whatsapp.getClient();
    if (status.ready && client) {
      sessionState = await client.getState();
    }
  } catch {
    sessionState = "ERROR";
  }

  const response = {
    status: status.ready ? "ok" : "error",
    whatsapp: {
      ready: status.ready,
      authenticated: status.ready,
      hasQr: status.qrCode !== null,
      state: sessionState,
      reconnecting: status.reconnecting,
    },
    timestamp: new Date().toISOString(),
  };

  if (status.ready && sessionState === "CONNECTED") {
    res.status(200).json(response);
  } else if (status.qrCode) {
    res.status(200).json({ ...response, message: "Waiting for QR code scan" });
  } else if (status.reconnecting) {
    res
      .status(503)
      .json({ ...response, message: "WhatsApp client is reconnecting" });
  } else {
    res.status(503).json({
      ...response,
      message: "WhatsApp client not initialized or disconnected",
    });
  }
});

app.get("/connect", authenticate, async (req, res) => {
  try {
    const status = whatsapp.getStatus();

    if (status.ready) {
      return res.status(200).json({
        status: "connected",
        message: "WhatsApp is already connected and ready",
      });
    }

    if (status.qrCode) {
      return res.status(200).json({
        status: "qr_ready",
        qr: status.qrCode,
        message: "Scan this QR code with WhatsApp",
      });
    }

    res.status(202).json({
      status: "generating",
      message: "QR code is being generated, please try again in a few seconds",
    });
  } catch (error) {
    console.error("Error in /connect:", error);
    res.status(500).json({
      status: "error",
      message: "Failed to generate QR code",
      error: error.message,
    });
  }
});

app.post("/send-msg", authenticate, async (req, res) => {
  let whatsappNumber = null;
  try {
    const { to, message } = req.body;

    if (!to || !message) {
      return res.status(400).json({
        status: "error",
        message:
          "Faltan campos requeridos: 'to' y 'message' son obligatorios",
      });
    }

    const status = whatsapp.getStatus();
    if (!status.ready) {
      const msg = status.reconnecting
        ? "El cliente de WhatsApp se está reconectando. Por favor intenta de nuevo en unos segundos."
        : "El cliente de WhatsApp no está listo. Por favor conéctate primero usando el endpoint /connect";
      return res.status(503).json({ status: "error", message: msg });
    }

    const client = whatsapp.getClient();
    let phoneNumber = to.replace(/\D/g, "").replace("@c.us", "");

    if (!phoneNumber || phoneNumber.length < 10) {
      return res.status(400).json({
        status: "error",
        message:
          "Formato de número inválido. El número debe tener al menos 10 dígitos.",
      });
    }

    try {
      const numberId = await client.getNumberId(phoneNumber);
      if (numberId) {
        whatsappNumber = numberId._serialized;
      } else {
        return res.status(400).json({
          status: "error",
          message: "Este numero no tiene WhatsApp",
          phoneNumber: phoneNumber,
          originalInput: to,
        });
      }
    } catch (validationError) {
      const msg = validationError.message || "";
      if (
        msg.includes("not registered") ||
        msg.includes("not found") ||
        msg.includes("No LID") ||
        msg.includes("LID for user")
      ) {
        return res.status(400).json({
          status: "error",
          message: "Este numero no tiene WhatsApp",
          phoneNumber: phoneNumber,
          originalInput: to,
        });
      }
      console.log("Validation error, attempting send anyway");
    }

    const result = await client.sendMessage(whatsappNumber, message, {
      sendSeen: false,
    });

    res.status(200).json({
      status: "success",
      message: "Mensaje enviado exitosamente",
      messageId: result.id._serialized,
      to: whatsappNumber,
    });
  } catch (error) {
    console.error("Error sending message:", error.message);

    const errorMsg = error.message || "";
    const errorName = error.name || "";
    let errorMessage = "Error al enviar el mensaje";

    if (
      errorMsg.includes("Session closed") ||
      errorMsg.includes("Target closed") ||
      errorMsg.includes("Protocol error") ||
      errorMsg.includes("Target.setDiscoverTargets") ||
      errorName === "TargetCloseError" ||
      errorName === "ProtocolError"
    ) {
      try {
        whatsapp.reconnect();
      } catch {
        // Already reconnecting
      }
      errorMessage =
        "La sesión de WhatsApp expiró o se perdió la conexión. Reconectando automáticamente.";
    } else if (
      errorMsg.includes("No LID for user") ||
      errorMsg.includes("LID for user")
    ) {
      errorMessage = "Este numero no tiene WhatsApp";
    } else if (
      errorMsg.includes("markedUnread") ||
      errorMsg.includes("Cannot read properties of undefined")
    ) {
      errorMessage = "Este numero no tiene WhatsApp";
    } else if (
      errorMsg.includes("Evaluation failed") ||
      errorMsg.includes("ExecutionContext")
    ) {
      try {
        whatsapp.reconnect();
      } catch {
        // Already reconnecting
      }
      errorMessage =
        "Error de conexión con WhatsApp. Reconectando automáticamente.";
    } else if (errorMsg === "t") {
      errorMessage = "Este numero no tiene WhatsApp";
    } else if (
      errorMsg.includes("not registered") ||
      errorMsg.includes("not found")
    ) {
      errorMessage = "Este numero no tiene WhatsApp";
    } else {
      errorMessage =
        "Error al enviar el mensaje. Por favor verifica el número e intenta de nuevo.";
    }

    res.status(500).json({
      status: "error",
      message: errorMessage,
      error: error.message || "Unknown error",
      phoneNumber: whatsappNumber || "unknown",
    });
  }
});

app.post("/reconnect", authenticate, async (req, res) => {
  try {
    await whatsapp.reconnect();
    res.status(200).json({
      status: "success",
      message: "Reconnection initiated. Check /health for status.",
    });
  } catch (error) {
    if (error.message === "Reconnection already in progress") {
      return res.status(409).json({ status: "error", message: error.message });
    }
    res.status(500).json({
      status: "error",
      message: "Failed to initiate reconnection",
      error: error.message,
    });
  }
});

app.post("/logout", authenticate, async (req, res) => {
  try {
    await whatsapp.logout();
    res.status(200).json({
      status: "success",
      message:
        "Logged out. Session cleared. Scan QR code again via /connect.",
    });
  } catch (error) {
    console.error("Error in /logout:", error);
    res.status(500).json({
      status: "error",
      message: "Failed to logout",
      error: error.message,
    });
  }
});

app.get("/", (req, res) => {
  res.json({
    message: "WhatsApp Web API",
    endpoints: {
      health: "GET /health",
      connect: "GET /connect",
      sendMsg: "POST /send-msg",
      reconnect: "POST /reconnect",
      logout: "POST /logout",
    },
    authentication: AUTH_SECRET ? "Enabled" : "Disabled (dev mode)",
  });
});

// Start server immediately so health checks work during init
app.listen(PORT, () => {
  console.log(`✓ Server running on port ${PORT}`);
});

whatsapp.initialize().catch((err) => {
  console.error("WhatsApp initialization error:", err.message);
});

async function gracefulShutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  await whatsapp.shutdown();
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
