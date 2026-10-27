/**
 * api.ts — REST API calls to the FastAPI backend.
 */

import { BACKEND_URL, ROOM_NAME } from "../constants";

export interface TokenResponse {
  token: string;
  url: string;
  room: string;
  identity: string;
}

/** Fetch a LiveKit JWT for the given user identity. */
export async function fetchToken(userId: string): Promise<TokenResponse> {
  const res = await fetch(`${BACKEND_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, room: ROOM_NAME }),
  });
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
  return res.json();
}

/** Register a device's push token with the backend. */
export async function registerDevice(
  userId: string,
  platform: "ios" | "android",
  pushToken: string
): Promise<void> {
  await fetch(`${BACKEND_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      platform,
      push_token: pushToken,
    }),
  });
}

/**
 * Trigger a drop-in to the other person.
 * The backend figures out who the target is based on from_user_id.
 */
export async function triggerDropIn(
  fromUserId: string,
  action: "drop_in" | "hang_up" = "drop_in"
): Promise<void> {
  await fetch(`${BACKEND_URL}/drop-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from_user_id: fromUserId, action }),
  });
}

/** Health check — useful for debugging connection issues. */
export async function healthCheck(): Promise<Record<string, unknown>> {
  const res = await fetch(`${BACKEND_URL}/health`);
  return res.json();
}
