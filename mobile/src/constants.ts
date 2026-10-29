export const BACKEND_URL = "http://192.168.29.27:8000"; // Your LAN IP
export const WS_URL = "ws://192.168.29.27:8000/ws";     // FastAPI WebSocket

// Auto-detect identity based on OS
const isWindows = navigator.userAgent.includes('Windows');
export const MY_ID = isWindows ? "windows-user" : "android-user";
export const PARTNER_ID = isWindows ? "android-user" : "windows-user";

// Free Google STUN servers for NAT Traversal (Zero Cost)
export const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

export const COLORS = {
  background: "#07070F",
  surface: "#0F0F1E",
  primary: "#7C6AFF",
  primaryGlow: "#7C6AFF44",
  success: "#22D3EE",
  danger: "#FF4D6A",
  textPrimary: "#F0F0FF",
  textSecondary: "#8080AA",
};