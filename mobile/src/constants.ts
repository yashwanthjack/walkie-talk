/**
 * constants.ts — Shared configuration for both iOS and Android apps.
 * Update BACKEND_URL with your deployed backend address.
 */

// ─── Backend ───────────────────────────────────────────────────────────────
// Local dev: your machine's LAN IP so both phones can reach it on the same WiFi
// Run `ipconfig` to find your LAN IP (e.g. 192.168.1.x)
// Deployed: your Railway/Render URL
export const BACKEND_URL = "http://192.168.29.27:8000";

// WebSocket signaling endpoint — port 8001 (separate from HTTP API on 8000)
export const WS_URL = `ws://192.168.29.27:8001/ws`;

// ─── Room ──────────────────────────────────────────────────────────────────
export const ROOM_NAME = "walkie-talk-room";

// ─── User Identities ──────────────────────────────────────────────────────
// These must match what the backend's config.py has set.
// Your iPhone always identifies as IOS_USER_ID.
// Her Android always identifies as ANDROID_USER_ID.
export const IOS_USER_ID = "ios-user";
export const ANDROID_USER_ID = "android-user";

// ─── UI ───────────────────────────────────────────────────────────────────
export const COLORS = {
  background: "#07070F",
  surface: "#0F0F1E",
  surfaceElevated: "#16162A",
  border: "#1E1E3A",
  primary: "#7C6AFF",         // Purple glow — PTT active
  primaryGlow: "#7C6AFF44",
  success: "#22D3EE",         // Cyan — partner online
  danger: "#FF4D6A",          // Red — disconnected
  warning: "#FFB547",         // Amber — connecting
  textPrimary: "#F0F0FF",
  textSecondary: "#8080AA",
  textMuted: "#404065",
} as const;
