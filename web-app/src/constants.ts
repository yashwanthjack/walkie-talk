/**
 * constants.ts — Shared config for the Walkie-Talkie PWA.
 *
 * HOW TO CONFIGURE:
 *   1. Run `ipconfig` (Windows) or `ip addr` (Linux/Android Termux) to find your LAN IP.
 *   2. Replace BACKEND_IP below with that IP so all devices on the same WiFi can reach the server.
 *   3. For internet access (outside your home WiFi), deploy the backend and put its URL here.
 *
 * ROOM & USER IDs:
 *   - Both devices must use the same ROOM_ID to be paired together.
 *   - Each device must have a unique USER_ID within that room.
 *   - You can change these freely — they are just strings.
 */

// ─── Backend ────────────────────────────────────────────────────────────────
// Live Render backend for production deployment.
export const WS_BASE_URL = 'wss://walkie-talk.onrender.com';

// ─── WebRTC ──────────────────────────────────────────────────────────────────
export const RTC_CONFIG: RTCConfiguration = {
  iceCandidatePoolSize: 10,
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
};

// ─── Design Tokens ───────────────────────────────────────────────────────────
export const COLORS = {
  background:      "#07070F",
  surface:         "#0F0F1E",
  surfaceElevated: "#16162A",
  border:          "#1E1E3A",
  primary:         "#7C6AFF",
  primaryDim:      "#7C6AFF33",
  primaryGlow:     "#7C6AFF",
  success:         "#22D3EE",
  successDim:      "#22D3EE22",
  danger:          "#FF4D6A",
  dangerDim:       "#FF4D6A22",
  warning:         "#FFB547",
  textPrimary:     "#F0F0FF",
  textSecondary:   "#8080AA",
  textMuted:       "#404065",
} as const;
