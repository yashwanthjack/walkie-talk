/**
 * useLiveKit.ts — LiveKit room connection and audio track management.
 *
 * Handles:
 * - Fetching a token from the backend
 * - Connecting to the LiveKit room
 * - Publishing the local microphone track (muted by default)
 * - Subscribing to the remote audio track and playing it
 * - Mute/unmute for PTT (push-to-talk)
 */

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Room,
  RoomEvent,
  LocalTrack,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
  Track,
  createLocalAudioTrack,
} from "livekit-client";
import { fetchToken } from "../services/api";
import { ROOM_NAME } from "../constants";

export type RoomStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

interface UseLiveKitOptions {
  userId: string;
  enabled: boolean;              // Set false to stay disconnected (e.g., during setup)
}

interface UseLiveKitReturn {
  status: RoomStatus;
  isTransmitting: boolean;       // Local mic is unmuted and sending
  isReceiving: boolean;          // Remote participant is sending audio
  startTransmitting: () => Promise<void>;
  stopTransmitting: () => void;
  room: Room | null;
  error: string | null;
}

export function useLiveKit({ userId, enabled }: UseLiveKitOptions): UseLiveKitReturn {
  const [status, setStatus] = useState<RoomStatus>("idle");
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [isReceiving, setIsReceiving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roomRef = useRef<Room | null>(null);
  const localAudioRef = useRef<LocalTrack | null>(null);

  // ── Connect to LiveKit room ─────────────────────────────────────────────
  const connect = useCallback(async () => {
    if (!enabled || !userId) return;

    try {
      setStatus("connecting");
      setError(null);

      // 1. Get JWT from our backend
      const { token, url } = await fetchToken(userId);

      // 2. Create Room with audio-optimised settings
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        audioOutput: {
          deviceId: "default",
        },
      });
      roomRef.current = room;

      // 3. Attach room event listeners
      room
        .on(RoomEvent.Connected, () => {
          setStatus("connected");
        })
        .on(RoomEvent.Reconnecting, () => setStatus("reconnecting"))
        .on(RoomEvent.Reconnected, () => setStatus("connected"))
        .on(RoomEvent.Disconnected, () => {
          setStatus("disconnected");
          setIsTransmitting(false);
          setIsReceiving(false);
        })
        .on(
          RoomEvent.TrackSubscribed,
          (track: RemoteTrack, _pub: RemoteTrackPublication, _participant: RemoteParticipant) => {
            if (track.kind === Track.Kind.Audio) {
              // Auto-play remote audio through the device speaker
              track.attach();
              setIsReceiving(true);
            }
          }
        )
        .on(
          RoomEvent.TrackUnsubscribed,
          (track: RemoteTrack) => {
            if (track.kind === Track.Kind.Audio) {
              track.detach();
              setIsReceiving(false);
            }
          }
        );

      // 4. Connect — join silently (mic muted) to save battery
      await room.connect(url, token);

      // 5. Create local audio track but start muted (PTT model)
      const audioTrack = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      await room.localParticipant.publishTrack(audioTrack, {
        audioBitrate: 32_000,       // 32 kbps — good quality, low bandwidth
        dtx: true,                  // Discontinuous transmission (saves bandwidth during silence)
      });
      audioTrack.mute();            // Start muted — unmute only while holding PTT button
      localAudioRef.current = audioTrack;

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[LiveKit] Connection error:", message);
      setError(message);
      setStatus("error");
    }
  }, [userId, enabled]);

  useEffect(() => {
    connect();
    return () => {
      localAudioRef.current?.stop();
      roomRef.current?.disconnect();
    };
  }, [connect]);

  // ── PTT Controls ───────────────────────────────────────────────────────
  const startTransmitting = useCallback(async () => {
    const track = localAudioRef.current;
    if (!track) return;
    await track.unmute();
    setIsTransmitting(true);
  }, []);

  const stopTransmitting = useCallback(() => {
    const track = localAudioRef.current;
    if (!track) return;
    track.mute();
    setIsTransmitting(false);
  }, []);

  return {
    status,
    isTransmitting,
    isReceiving,
    startTransmitting,
    stopTransmitting,
    room: roomRef.current,
    error,
  };
}
