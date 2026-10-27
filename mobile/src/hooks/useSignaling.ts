/**
 * useSignaling.ts — WebSocket signaling hook.
 *
 * Maintains a persistent WebSocket connection to the backend.
 * The backend uses this channel to deliver drop-in events in real-time
 * (fallback to FCM for when the app is fully backgrounded on Android).
 *
 * Events received:
 *   { type: "drop_in",       from: string, room: string }
 *   { type: "hang_up",       from: string }
 *   { type: "partner_online", user: string }
 *   { type: "partner_offline", user: string }
 *   { type: "heartbeat_ack" }
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { WS_URL } from "../constants";

export type SignalingEvent =
  | { type: "drop_in"; from: string; room: string }
  | { type: "hang_up"; from: string }
  | { type: "partner_online"; user: string }
  | { type: "partner_offline"; user: string }
  | { type: "heartbeat_ack" }
  | { type: "mic_mute"; from: string }
  | { type: "mic_unmute"; from: string };

interface UseSignalingOptions {
  userId: string;
  onEvent: (event: SignalingEvent) => void;
}

export interface SignalingHandle {
  send: (event: Record<string, unknown>) => void;
  connected: boolean;
}

const HEARTBEAT_INTERVAL_MS = 20_000;  // Ping every 20s to keep connection alive
const RECONNECT_DELAY_MS = 3_000;      // Reconnect after 3s on disconnect

export function useSignaling({ userId, onEvent }: UseSignalingOptions): SignalingHandle {
  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const clearTimers = useCallback(() => {
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    if (reconnectRef.current) clearTimeout(reconnectRef.current);
  }, []);

  const connect = useCallback(() => {
    if (!userId) return;

    const url = `${WS_URL}/${userId}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      // Start heartbeat to prevent connection timeout
      heartbeatRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "heartbeat" }));
        }
      }, HEARTBEAT_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as SignalingEvent;
        onEventRef.current(data);
      } catch {
        console.warn("[Signaling] Failed to parse message:", event.data);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      clearTimers();
      // Auto-reconnect after delay
      reconnectRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };

    ws.onerror = (e) => {
      console.error("[Signaling] WS error:", e);
      ws.close();
    };
  }, [userId, clearTimers]);

  useEffect(() => {
    connect();
    return () => {
      clearTimers();
      wsRef.current?.close();
    };
  }, [connect, clearTimers]);

  const send = useCallback((event: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }, []);

  return { send, connected };
}
