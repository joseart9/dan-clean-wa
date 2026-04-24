# WhatsApp Web Backend API

A Node.js backend service that provides REST API endpoints to send WhatsApp messages using WhatsApp Web.js.

## Features

- 🔐 WhatsApp Web authentication via QR code
- 🔒 JWT Authentication (shared secret with NextJS app)
- 📱 Send WhatsApp messages via REST API
- ❤️ Health check endpoint for monitoring
- 🔄 Automatic session refresh and reconnection
- 💾 Persistent session storage
- 🚀 Production-ready and Railway deployment ready

## Endpoints

### 1. Health Check (Public)

**GET** `/health`

Returns the status of the WhatsApp connection. No authentication required.

**Response:**

```json
{
  "status": "ok",
  "whatsapp": {
    "ready": true,
    "authenticated": true,
    "hasQr": false,
    "state": "CONNECTED",
    "reconnecting": false
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 2. Connect (Protected)

**GET** `/connect`

Returns a QR code (as base64 data URL) for WhatsApp authentication. Scan this QR code with your WhatsApp mobile app to establish a session.

**Authentication:** Required (JWT token in cookie or Authorization header)

**Response:**

```json
{
  "status": "qr_ready",
  "qr": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
  "message": "Scan this QR code with WhatsApp"
}
```

### 3. Send Message (Protected)

**POST** `/send-msg`

Sends a WhatsApp message to a specified phone number.

**Authentication:** Required (JWT token in cookie or Authorization header)

**Request Body:**

```json
{
  "to": "8117858904",
  "message": "Hello from WhatsApp API!"
}
```

**Note:** Phone numbers should be provided without the country code. The API automatically adds Mexico's country code (52) if not present. For example, `8117858904` becomes `528117858904@c.us`.

**Response:**

```json
{
  "status": "success",
  "message": "Message sent successfully",
  "messageId": "true_1234567890@c.us_3EB0123456789ABCDEF",
  "to": "1234567890@c.us"
}
```

### 4. Reconnect (Protected)

**POST** `/reconnect`

Manually trigger WhatsApp client reconnection. Useful if the session appears stuck.

**Authentication:** Required (JWT token in cookie or Authorization header)

**Response:**

```json
{
  "status": "success",
  "message": "Reconnection initiated. Please check /health endpoint for status."
}
```

### 5. Logout (Protected)

**POST** `/logout`

Destroys the current WhatsApp session and clears all authentication data. After logout, you'll need to scan a new QR code to reconnect.

**Authentication:** Required (JWT token in cookie or Authorization header)

**Response:**

```json
{
  "status": "success",
  "message": "Logged out successfully. Session cleared. Please scan QR code again via /connect endpoint."
}
```

**Note:** After logout, the client will automatically reinitialize and generate a new QR code. Call `/connect` to get the new QR code.

## Installation

1. Install dependencies:

```bash
npm install
```

2. Set up environment variables:

Create a `.env` file (or set environment variables in Railway):

```env
PORT=4000
AUTH_SECRET=your-jwt-secret-key-here
```

**Important:** The `AUTH_SECRET` should be the same JWT secret used in your NextJS app. This allows the backend to verify tokens issued by your frontend.

3. Start the server:

```bash
npm start
```

The server will run on port 4000 by default (or the port specified in the `PORT` environment variable).

## Usage

1. **Start the server**: `npm start`
2. **Get QR code**: Call `GET /connect` with your JWT token in the `token` header
3. **Scan QR code**: Open WhatsApp on your phone → Settings → Linked Devices → Link a Device, then scan the QR code
4. **Check health**: Call `GET /health` with your JWT token in the `token` header
5. **Send messages**: POST to `/send-msg` with `to` and `message` in the body, including your JWT token in the `token` header

## Authentication

The backend uses JWT authentication shared with your NextJS app:

- **Token Location**: JWT token should be sent in one of these ways (checked in order):
  1. In a `token` header (recommended)
  2. In a cookie named `token`
  3. In the `Authorization` header as `Bearer <token>`
- **Secret**: Must match the `AUTH_SECRET` environment variable (same as NextJS app)
- **Development Mode**: If `AUTH_SECRET` is not set, authentication is disabled (for local testing only)

### Example Request (with token header - recommended):

```bash
curl -X POST http://localhost:4000/send-msg \
  -H "Content-Type: application/json" \
  -H "token: your-jwt-token" \
  -d '{"to": "+1234567890", "message": "Hello"}'
```

### Example Request (with cookie):

```bash
curl -X POST http://localhost:4000/send-msg \
  -H "Content-Type: application/json" \
  -H "Cookie: token=your-jwt-token" \
  -d '{"to": "+1234567890", "message": "Hello"}'
```

### Example Request (with Authorization header):

```bash
curl -X POST http://localhost:4000/send-msg \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-jwt-token" \
  -d '{"to": "+1234567890", "message": "Hello"}'
```

## Phone Number Format

The `to` field should be a phone number without the country code. The API automatically:

- Adds Mexico's country code (52) if not present
- Formats it to WhatsApp's format (e.g., `8117858904` → `528117858904@c.us`)

**Examples:**

- Input: `8117858904` → Output: `528117858904@c.us`
- Input: `528117858904` → Output: `528117858904@c.us` (already has country code)
- Input: `+528117858904` → Output: `528117858904@c.us` (+ sign is removed)

**Note:** All numbers are assumed to be from Mexico. If you need to send to other countries, include the full international number with country code.

## Deployment on Railway

### IMPORTANT: Mount a persistent volume for session data

Railway containers have **ephemeral filesystems by default** — every deploy/restart wipes `.wwebjs_auth/`, forcing a new QR scan and (over time) causing WhatsApp to invalidate the session. To keep the WhatsApp client logged in for months, mount a Railway Volume:

1. Push your code to a Git repository
2. Create a new project on Railway and connect your repository
3. In the service settings, go to **Volumes** → **New Volume**
4. Set the **mount path** to `/app/.wwebjs_auth`
5. Redeploy the service

That's it. The app auto-detects the volume via Railway's `RAILWAY_VOLUME_MOUNT_PATH` env var and stores all WhatsApp session files there. Sessions now survive every deploy, restart, OOM, and platform maintenance event.

If you ever see this warning in logs, your volume is not mounted correctly:

```
⚠ Running on Railway WITHOUT a persistent volume mounted...
```

### Environment Variables

- `PORT` - Server port (default: 4000)
- `AUTH_SECRET` - JWT secret key for authentication (must match NextJS app secret). If not set, authentication is disabled (development mode only).
- `WWEBJS_DATA_PATH` - (Optional) Override the WhatsApp session storage directory. On Railway, `RAILWAY_VOLUME_MOUNT_PATH` is used automatically when a volume is attached.

## Session Management

The backend uses **`LocalAuth`** from `whatsapp-web.js`, which stores the WhatsApp session as a real Chromium profile on disk. This is the most reliable session strategy and the one officially recommended by `whatsapp-web.js`.

- **Persistent Sessions**: Stored at `RAILWAY_VOLUME_MOUNT_PATH` (Railway) or `./.wwebjs_auth` (local dev)
- **Always-in-sync tokens**: Unlike `RemoteAuth`, there is no backup interval — every WhatsApp token rotation is written to disk immediately, so restored sessions are never stale
- **Automatic Reconnection**: If the session disconnects unexpectedly, the backend automatically attempts to reconnect
- **Health Monitoring**: Periodic health checks (every 5 min) ensure the session stays active
- **Manual Reconnection**: Use the `/reconnect` endpoint to manually trigger reconnection if needed

### Session Lifecycle

1. **Initial Connection**: Scan QR code once via `/connect` endpoint
2. **Session Saved**: Chromium writes the session profile to the data path on every change
3. **Automatic Reconnection**: If disconnected, the backend automatically reconnects using the saved session
4. **Re-authentication**: Only required if WhatsApp itself invalidates the device (rare — typically months) or you call `/logout`

### Why not MongoDB / RemoteAuth?

This project previously used `wwebjs-mongo` + `RemoteAuth` to back sessions to MongoDB. That strategy was removed because:

- `RemoteAuth` only syncs to the remote store on an interval (default 5–15 min). On every container restart, the restored session can be up to one interval **stale**, and after a few stale restores WhatsApp force-logs-out the device. This caused logouts every 2–3 days.
- `wwebjs-mongo@1.1.0` has well-documented unresolved bugs around zip compression/extraction (see issues [#2631](https://github.com/wwebjs/whatsapp-web.js/issues/2631), [#2667](https://github.com/wwebjs/whatsapp-web.js/issues/2667), [#5781](https://github.com/wwebjs/whatsapp-web.js/issues/5781)).
- Railway natively supports persistent volumes, which makes `LocalAuth` strictly better here.

## Notes

- The WhatsApp session is stored at `RAILWAY_VOLUME_MOUNT_PATH` on Railway, or `./.wwebjs_auth` locally
- Once authenticated, the session persists across deploys and restarts (when a Railway Volume is mounted)
- The QR code is only available when the client is not authenticated
- Automatic reconnection means you rarely need to scan the QR code again

## License

ISC
