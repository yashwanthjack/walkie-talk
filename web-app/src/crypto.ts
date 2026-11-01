/**
 * crypto.ts — Zero-Dependency Native Client-Side Web Crypto
 *
 * Implements end-to-end encryption for WebRTC signaling and verification:
 * - PBKDF2 (SHA-256, 100,000 iterations) to derive AES-GCM 256-bit key from Room + Secret PIN.
 * - AES-GCM (256-bit) payload encryption with random 12-byte IV for all WebRTC signaling.
 * - SDP Fingerprint verification generating a 4-emoji Safety Number badge.
 */

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Derives an AES-GCM 256-bit CryptoKey using PBKDF2 (SHA-256, 100,000 iterations).
 * The salt is deterministically derived from the clean roomId.
 */
export async function deriveRoomKey(roomId: string, secretPin: string): Promise<CryptoKey> {
  const cleanRoom = roomId.trim().toLowerCase();
  const cleanPin = secretPin.trim();
  const passwordMaterial = cleanPin ? `${cleanRoom}::pin::${cleanPin}` : `sandcastle-open-channel::${cleanRoom}`;

  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw',
    enc.encode(passwordMaterial),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const salt = enc.encode(`sandcastle-salt::${cleanRoom}`);

  return window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    {
      name: 'AES-GCM',
      length: 256,
    },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts an arbitrary JSON-serializable signal payload with AES-GCM using a 12-byte random IV.
 */
export async function encryptSignal(
  key: CryptoKey,
  payloadObj: unknown
): Promise<{ iv: string; ciphertext: string }> {
  const enc = new TextEncoder();
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const data = enc.encode(JSON.stringify(payloadObj));

  const encryptedBuffer = await window.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    key,
    data
  );

  return {
    iv: bufferToBase64(iv.buffer),
    ciphertext: bufferToBase64(encryptedBuffer),
  };
}

/**
 * Decrypts an AES-GCM ciphertext using the derived CryptoKey and base64 IV.
 */
export async function decryptSignal(
  key: CryptoKey,
  ivBase64: string,
  ciphertextBase64: string
): Promise<unknown> {
  const iv = new Uint8Array(base64ToBuffer(ivBase64));
  const ciphertext = base64ToBuffer(ciphertextBase64);

  const decryptedBuffer = await window.crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    key,
    ciphertext
  );

  const dec = new TextDecoder();
  return JSON.parse(dec.decode(decryptedBuffer));
}

/**
 * Extracts the DTLS-SRTP fingerprint line from an SDP session description.
 */
export function extractSdpFingerprint(sdp: string | null | undefined): string | null {
  if (!sdp) return null;
  // Match SDP fingerprint: a=fingerprint:sha-256 12:34:56:AB:...
  const match = sdp.match(/a=fingerprint:\S+\s+([0-9A-Fa-f:]+)/);
  return match ? match[1].toUpperCase() : null;
}

const EMOJI_PALETTE = [
  '🏰', '🛡️', '🌊', '🐚', '🦀', '🏖️', '🌴', '⚓',
  '🐬', '🧭', '🗝️', '☀️', '⛵', '🏝️', '💎', '🔮',
];

/**
 * Hashes both SDP fingerprints into a deterministic 4-emoji Safety Number.
 * Both peers compute the exact same 4 emojis by sorting the fingerprints.
 */
export async function computeSafetyNumber(
  localFingerprint: string | null,
  remoteFingerprint: string | null
): Promise<string | null> {
  if (!localFingerprint || !remoteFingerprint) return null;

  const combined = [localFingerprint, remoteFingerprint].sort().join('::');
  const enc = new TextEncoder();
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', enc.encode(combined));
  const hashBytes = new Uint8Array(hashBuffer);

  const emojis: string[] = [];
  for (let i = 0; i < 4; i++) {
    const idx = hashBytes[i] % EMOJI_PALETTE.length;
    emojis.push(EMOJI_PALETTE[idx]);
  }

  return emojis.join(' ');
}

