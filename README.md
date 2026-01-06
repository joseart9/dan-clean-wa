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
  "to": "1234567890",
  "message": "Hello from WhatsApp API!"
}
```

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

The `to` field should be a phone number. The API will automatically format it to WhatsApp's format (e.g., `1234567890@c.us`).

For international numbers, include the country code without the `+` sign or with it (e.g., `551234567890` or `+551234567890`).

## Deployment on Railway

1. Push your code to a Git repository
2. Create a new project on Railway
3. Connect your repository
4. Railway will automatically detect Node.js and install dependencies
5. The server will start automatically using the `start` script

**Note**: The WhatsApp session data (`.wwebjs_auth/`) will persist between deployments on Railway, so you won't need to scan the QR code again unless the session expires.

## Environment Variables

- `PORT` - Server port (default: 4000)
- `AUTH_SECRET` - JWT secret key for authentication (must match NextJS app secret). If not set, authentication is disabled (development mode only).

## Session Management

The backend includes automatic session management:

- **Persistent Sessions**: WhatsApp session is stored in `.wwebjs_auth/` directory and persists between server restarts
- **Automatic Reconnection**: If the session disconnects unexpectedly, the backend automatically attempts to reconnect
- **Session Refresh**: The backend listens for session refresh events and handles them automatically
- **Health Monitoring**: Periodic health checks ensure the session stays active
- **Manual Reconnection**: Use the `/reconnect` endpoint to manually trigger reconnection if needed

### Session Lifecycle

1. **Initial Connection**: Scan QR code once via `/connect` endpoint
2. **Session Saved**: Session is automatically saved to `.wwebjs_auth/` directory
3. **Automatic Reconnection**: If disconnected, the backend automatically reconnects using saved session
4. **Session Refresh**: WhatsApp Web.js handles session refresh automatically
5. **Re-authentication**: Only required if session is completely invalidated (rare)

## Notes

- The WhatsApp session is stored in `.wwebjs_auth/` directory
- Once authenticated, the session persists between deployments and server restarts
- The QR code is only available when the client is not authenticated
- Automatic reconnection means you rarely need to scan the QR code again
- Session data persists on Railway between deployments (ephemeral storage)

## License

ISC
