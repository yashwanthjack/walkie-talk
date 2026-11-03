/**
 * constants.ts — Shared config and Sandcastle Design System tokens.
 */

// ─── Backend ────────────────────────────────────────────────────────────────
export const WS_BASE_URL = 'wss://walkie-talk.onrender.com';

// ─── WebRTC ──────────────────────────────────────────────────────────────────
export const RTC_CONFIG: RTCConfiguration = {
  iceCandidatePoolSize: 10,
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
};

// ─── Sandcastle Design Tokens ───────────────────────────────────────────────
export const COLORS = {
  // Sandcastle Brand Colors
  sandLight:       '#F7F4EE',
  sandMedium:      '#EFEAE0',
  sandBorder:      '#E4DCD0',
  sandDarkText:    '#1C1917',
  sandMutedText:   '#78716C',

  // Walkie-Talkie Chassis (Warm Dark Basalt)
  chassisBg:       '#1A1816',
  chassisSurface:  '#23201C',
  chassisElevated: '#2D2924',
  chassisBorder:   '#3A352E',

  // Brand Accents
  terracotta:      '#D96343',
  terracottaHover: '#C65435',
  terracottaGlow:  'rgba(217, 99, 67, 0.45)',
  olive:           '#5F6F52',
  oliveDim:        'rgba(95, 111, 82, 0.18)',

  // Indicators
  emerald:         '#10B981',
  emeraldDim:      'rgba(16, 185, 129, 0.18)',
  danger:          '#EF4444',
  dangerDim:       'rgba(239, 68, 68, 0.18)',
  warning:         '#F59E0B',

  // Legacy mappings for backwards compatibility
  background:      '#F7F4EE',
  surface:         '#23201C',
  surfaceElevated: '#2D2924',
  border:          '#3A352E',
  primary:         '#D96343',
  primaryDim:      'rgba(217, 99, 67, 0.25)',
  primaryGlow:     '#D96343',
  success:         '#10B981',
  successDim:      'rgba(16, 185, 129, 0.2)',
  textPrimary:     '#F5F2EB',
  textSecondary:   '#A8A29E',
  textMuted:       '#78716C',
} as const;
