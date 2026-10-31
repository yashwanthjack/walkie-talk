import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ForegroundService,
  Importance,
  ServiceType,
} from '@capawesome-team/capacitor-android-foreground-service';
import { WS_BASE_URL, RTC_CONFIG, COLORS } from './constants';
import {
  playPttStartChirp,
  playTransmissionEnd,
  playBuzzerSound,
} from './audioEffects';
import { hashRoomWithPin } from './utils/security';
import './App.css';

// ─── Types ───────────────────────────────────────────────────────────────────
type AppPhase = 'join' | 'connecting' | 'ready';
type ConnState = 'disconnected' | 'connecting' | 'connected';

interface ReplayClip {
  id: string;
  url: string;
  durationSec: number;
  timeStr: string;
}

interface TelemetryData {
  battery?: number | null;
  charging?: boolean;
  rttMs?: number | null;
}

// ─── Main App ────────────────────────────────────────────────────────────────
export default function App() {
  const [phase, setPhase] = useState<AppPhase>('join');
  const [roomId, setRoomId] = useState('');
  const [roomPin, setRoomPin] = useState('');
  const [userId, setUserId] = useState('');
  const [isPinProtected, setIsPinProtected] = useState(false);
  const [connState, setConnState] = useState<ConnState>('disconnected');
  const [peers, setPeers] = useState<string[]>([]);

  // Refs for WebRTC callbacks & state guards
  const peersRef = useRef<string[]>([]);
  useEffect(() => {
    peersRef.current = peers;
  }, [peers]);

  const [isTransmitting, setIsTransmitting] = useState(false);
  const isTransmittingRef = useRef(false);
  useEffect(() => {
    isTransmittingRef.current = isTransmitting;
  }, [isTransmitting]);

  const [isReceiving, setIsReceiving] = useState(false);
  const isReceivingRef = useRef(false);
  useEffect(() => {
    isReceivingRef.current = isReceiving;
  }, [isReceiving]);

  const connStateRef = useRef<ConnState>('disconnected');
  useEffect(() => {
    connStateRef.current = connState;
  }, [connState]);

  const [statusMsg, setStatusMsg] = useState('Waiting for partner...');
  const [micAllowed, setMicAllowed] = useState<boolean | null>(null);
  const [incomingPing, setIncomingPing] = useState(false);
  const [buzzerAlert, setBuzzerAlert] = useState<string | null>(null);

  // Replay Last Transmission
  const [replayClips, setReplayClips] = useState<ReplayClip[]>([]);
  const [isPlayingReplay, setIsPlayingReplay] = useState<string | null>(null);
  const replayAudioRef = useRef<HTMLAudioElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordStartTimeRef = useRef<number>(0);
  const remoteStreamRef = useRef<MediaStream | null>(null);

  // VOX (Hands-Free Mode)
  const [voxEnabled, setVoxEnabled] = useState(false);
  const [voxLevel, setVoxLevel] = useState(0); // 0-100%
  const voxThreshold = 0.035; // RMS threshold
  const voxSilenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voxAudioCtxRef = useRef<AudioContext | null>(null);
  const voxAnalyserRef = useRef<AnalyserNode | null>(null);
  const voxAnimFrameRef = useRef<number | null>(null);
  const voxStreamRef = useRef<MediaStream | null>(null);

  // Screen Wake Lock
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const wakeLockSentinelRef = useRef<WakeLockSentinel | null>(null);

  // Telemetry (Battery & RTT)
  const [partnerTelemetry, setPartnerTelemetry] = useState<TelemetryData | null>(null);
  const telemetryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const pingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);
  const politeRef = useRef(false);

  // ICE candidate queue
  const iceCandidateQueueRef = useRef<RTCIceCandidateInit[]>([]);

  // ─── Wake Lock Management ────────────────────────────────────────────────
  const requestWakeLock = useCallback(async () => {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        const sentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinelRef.current = sentinel;
        setWakeLockActive(true);
        sentinel.addEventListener('release', () => {
          setWakeLockActive(false);
          wakeLockSentinelRef.current = null;
        });
      }
    } catch (e) {
      console.warn('Wake Lock request failed:', e);
    }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    try {
      if (wakeLockSentinelRef.current) {
        await wakeLockSentinelRef.current.release();
        wakeLockSentinelRef.current = null;
      }
    } catch {}
    setWakeLockActive(false);
  }, []);

  // ─── Cleanup ────────────────────────────────────────────────────────────
  const cleanup = useCallback(async () => {
    try {
      await ForegroundService.stopForegroundService();
    } catch (error) {
      console.warn('Foreground service stop failed:', error);
    }

    if (telemetryTimerRef.current) {
      clearInterval(telemetryTimerRef.current);
      telemetryTimerRef.current = null;
    }

    if (voxAnimFrameRef.current) {
      cancelAnimationFrame(voxAnimFrameRef.current);
      voxAnimFrameRef.current = null;
    }
    if (voxSilenceTimerRef.current) {
      clearTimeout(voxSilenceTimerRef.current);
      voxSilenceTimerRef.current = null;
    }
    voxStreamRef.current?.getTracks().forEach(t => t.stop());
    voxStreamRef.current = null;
    if (voxAudioCtxRef.current && voxAudioCtxRef.current.state !== 'closed') {
      voxAudioCtxRef.current.close().catch(() => {});
      voxAudioCtxRef.current = null;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
      mediaRecorderRef.current = null;
    }

    if (replayAudioRef.current) {
      replayAudioRef.current.pause();
      replayAudioRef.current = null;
    }

    await releaseWakeLock();

    wsRef.current?.close();
    pcRef.current?.close();
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    wsRef.current = null;
    pcRef.current = null;
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    iceCandidateQueueRef.current = [];
  }, [releaseWakeLock]);

  useEffect(() => {
    return () => {
      void cleanup();
    };
  }, [cleanup]);

  // Handle visibility changes for Wake Lock
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && phase === 'ready') {
        void requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [phase, requestWakeLock]);

  // ─── Flush queued ICE candidates ────────────────────────────────────────
  const flushIceCandidateQueue = async (pc: RTCPeerConnection) => {
    const queued = iceCandidateQueueRef.current;
    iceCandidateQueueRef.current = [];
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('Queued ICE candidate error:', e);
      }
    }
  };

  // ─── Start / Stop Incoming Recording (Replay Feature) ─────────────────────
  const startRecordingIncoming = () => {
    if (!remoteStreamRef.current || typeof MediaRecorder === 'undefined') return;
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      recordedChunksRef.current = [];
      recordStartTimeRef.current = Date.now();

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : '';

      const recorder = mimeType
        ? new MediaRecorder(remoteStreamRef.current, { mimeType })
        : new MediaRecorder(remoteStreamRef.current);

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        if (recordedChunksRef.current.length > 0) {
          const type = recorder.mimeType || 'audio/webm';
          const blob = new Blob(recordedChunksRef.current, { type });
          const durationSec = Math.max(1, Math.round((Date.now() - recordStartTimeRef.current) / 1000));
          const url = URL.createObjectURL(blob);
          const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

          setReplayClips(prev => [
            { id: Math.random().toString(36).substring(2, 9), url, durationSec, timeStr },
            ...prev.slice(0, 2), // Keep last 3
          ]);
        }
      };

      recorder.start(100);
      mediaRecorderRef.current = recorder;
    } catch (err) {
      console.warn('MediaRecorder recording error:', err);
    }
  };

  const stopRecordingIncoming = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch (err) {
        console.warn('MediaRecorder stop error:', err);
      }
      mediaRecorderRef.current = null;
    }
  };

  // ─── Play Replay Clip ────────────────────────────────────────────────────
  const handleTogglePlayReplay = (clip: ReplayClip) => {
    if (isPlayingReplay === clip.id) {
      replayAudioRef.current?.pause();
      setIsPlayingReplay(null);
      return;
    }

    if (!replayAudioRef.current) {
      replayAudioRef.current = new Audio();
    }
    const audio = replayAudioRef.current;
    audio.src = clip.url;
    setIsPlayingReplay(clip.id);

    audio.onended = () => setIsPlayingReplay(null);
    audio.onerror = () => setIsPlayingReplay(null);
    audio.play().catch(() => setIsPlayingReplay(null));
  };

  // ─── PTT Control (Transmit) ──────────────────────────────────────────────
  const handlePTTStart = useCallback(() => {
    // Channel collision lock: cannot transmit if channel is receiving or not connected
    if (connStateRef.current !== 'connected' || isReceivingRef.current || isTransmittingRef.current) {
      return;
    }
    setIsTransmitting(true);
    playPttStartChirp();

    localStreamRef.current?.getAudioTracks().forEach(t => (t.enabled = true));
    wsRef.current?.send(JSON.stringify({ type: 'ptt_start', target_id: peersRef.current[0] }));
    if (navigator.vibrate) navigator.vibrate(40);
  }, []);

  const handlePTTEnd = useCallback(() => {
    if (!isTransmittingRef.current) return;
    setIsTransmitting(false);
    playTransmissionEnd();

    localStreamRef.current?.getAudioTracks().forEach(t => (t.enabled = false));
    wsRef.current?.send(JSON.stringify({ type: 'ptt_end', target_id: peersRef.current[0] }));
  }, []);

  // ─── 1-Tap Buzzer / Paging Alert ─────────────────────────────────────────
  const sendBuzzer = () => {
    if (connState !== 'connected' || peers.length === 0) return;
    wsRef.current?.send(JSON.stringify({ type: 'buzzer', target_id: peersRef.current[0] }));
    playBuzzerSound();
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    setStatusMsg('⚡ Sent Buzz alert to partner!');
    setTimeout(() => {
      if (connStateRef.current === 'connected') {
        setStatusMsg('🟢 Partner connected');
      }
    }, 2500);
  };

  // ─── VOX (Voice-Activated Transmission) Loop ─────────────────────────────
  useEffect(() => {
    if (!voxEnabled || phase !== 'ready' || !localStreamRef.current) {
      if (voxAnimFrameRef.current) {
        cancelAnimationFrame(voxAnimFrameRef.current);
        voxAnimFrameRef.current = null;
      }
      setVoxLevel(0);
      return;
    }

    try {
      // Create independent audio context & stream for VOX level sensing
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      voxAudioCtxRef.current = ctx;

      // Clone track so VOX stays active even when localStream audio track is disabled (muted)
      const micTrack = localStreamRef.current.getAudioTracks()[0];
      if (!micTrack) return;
      const clonedTrack = micTrack.clone();
      clonedTrack.enabled = true;
      const sensingStream = new MediaStream([clonedTrack]);
      voxStreamRef.current = sensingStream;

      const source = ctx.createMediaStreamSource(sensingStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);
      voxAnalyserRef.current = analyser;

      const buffer = new Float32Array(analyser.fftSize);

      const checkAudioLevel = () => {
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
          sum += buffer[i] * buffer[i];
        }
        const rms = Math.sqrt(sum / buffer.length);
        // Normalize 0..1 to percentage 0..100
        const percentage = Math.min(100, Math.round(rms * 400));
        setVoxLevel(percentage);

        // Voice triggered threshold crossing
        if (rms >= voxThreshold) {
          if (!isTransmittingRef.current && !isReceivingRef.current && connStateRef.current === 'connected') {
            handlePTTStart();
          }
          if (voxSilenceTimerRef.current) {
            clearTimeout(voxSilenceTimerRef.current);
            voxSilenceTimerRef.current = null;
          }
        } else if (isTransmittingRef.current) {
          // Voice below threshold: start 1.2s silence hangover before auto-muting
          if (!voxSilenceTimerRef.current) {
            voxSilenceTimerRef.current = setTimeout(() => {
              handlePTTEnd();
              voxSilenceTimerRef.current = null;
            }, 1200);
          }
        }

        voxAnimFrameRef.current = requestAnimationFrame(checkAudioLevel);
      };

      voxAnimFrameRef.current = requestAnimationFrame(checkAudioLevel);
    } catch (err) {
      console.warn('VOX initialization error:', err);
    }

    return () => {
      if (voxAnimFrameRef.current) {
        cancelAnimationFrame(voxAnimFrameRef.current);
        voxAnimFrameRef.current = null;
      }
      if (voxSilenceTimerRef.current) {
        clearTimeout(voxSilenceTimerRef.current);
        voxSilenceTimerRef.current = null;
      }
      voxStreamRef.current?.getTracks().forEach(t => t.stop());
      voxStreamRef.current = null;
      if (voxAudioCtxRef.current && voxAudioCtxRef.current.state !== 'closed') {
        voxAudioCtxRef.current.close().catch(() => {});
        voxAudioCtxRef.current = null;
      }
    };
  }, [voxEnabled, phase, handlePTTStart, handlePTTEnd]);

  // ─── Hardware Keyboard (Spacebar) & MediaSession PTT ─────────────────────
  useEffect(() => {
    if (phase !== 'ready') return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          return;
        }
        e.preventDefault();
        handlePTTStart();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          return;
        }
        e.preventDefault();
        handlePTTEnd();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    // MediaSession API setup for lock screen & bluetooth buttons
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: 'Walkie-Talkie',
          artist: `Room: ${roomId}`,
          album: 'PTT Radio',
        });

        navigator.mediaSession.setActionHandler('play', () => handlePTTStart());
        navigator.mediaSession.setActionHandler('pause', () => handlePTTEnd());
        navigator.mediaSession.setActionHandler('stop', () => handlePTTEnd());
      } catch (err) {
        console.warn('MediaSession handler error:', err);
      }
    }

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.setActionHandler('play', null);
          navigator.mediaSession.setActionHandler('pause', null);
          navigator.mediaSession.setActionHandler('stop', null);
        } catch {}
      }
    };
  }, [phase, roomId, handlePTTStart, handlePTTEnd]);

  // ─── Telemetry Gathering (Battery & WebRTC RTT) ──────────────────────────
  useEffect(() => {
    if (phase !== 'ready' || connState !== 'connected') {
      if (telemetryTimerRef.current) {
        clearInterval(telemetryTimerRef.current);
        telemetryTimerRef.current = null;
      }
      return;
    }

    const reportTelemetry = async () => {
      if (wsRef.current?.readyState !== WebSocket.OPEN || peersRef.current.length === 0) return;

      let batteryLevel: number | null = null;
      let charging: boolean | undefined = undefined;

      if ('getBattery' in navigator) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const battery = await (navigator as any).getBattery();
          batteryLevel = Math.round(battery.level * 100);
          charging = battery.charging;
        } catch {}
      }

      let rttMs: number | null = null;
      if (pcRef.current) {
        try {
          const stats = await pcRef.current.getStats();
          for (const report of stats.values()) {
            if (
              report.type === 'candidate-pair' &&
              report.state === 'succeeded' &&
              report.currentRoundTripTime !== undefined
            ) {
              rttMs = Math.round(report.currentRoundTripTime * 1000);
              break;
            }
          }
        } catch {}
      }

      wsRef.current.send(
        JSON.stringify({
          type: 'telemetry',
          target_id: peersRef.current[0],
          battery: batteryLevel,
          charging,
          rtt: rttMs,
        })
      );
    };

    // Send immediately and then every 10s
    void reportTelemetry();
    telemetryTimerRef.current = setInterval(reportTelemetry, 10000);

    return () => {
      if (telemetryTimerRef.current) {
        clearInterval(telemetryTimerRef.current);
        telemetryTimerRef.current = null;
      }
    };
  }, [phase, connState]);

  // ─── Join Room ──────────────────────────────────────────────────────────
  const joinRoom = async () => {
    const rawRoom = roomId.trim();
    const rawUser = userId.trim();
    const rawPin = roomPin.trim();
    if (!rawRoom || !rawUser) return;

    setPhase('connecting');
    setStatusMsg('Requesting microphone...');

    // 1. Get mic
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      stream.getAudioTracks().forEach(t => (t.enabled = false)); // muted until PTT
      localStreamRef.current = stream;
      setMicAllowed(true);

      try {
        await ForegroundService.createNotificationChannel({
          id: 'walkie_talkie_channel',
          name: 'Walkie Talkie',
          description: 'Background microphone service for Walkie Talkie',
          importance: Importance.Default,
        });

        await ForegroundService.startForegroundService({
          id: 5001,
          title: 'Walkie-Talkie Active',
          body: `Room: ${rawRoom}`,
          smallIcon: 'ic_launcher_background',
          notificationChannelId: 'walkie_talkie_channel',
          serviceType: ServiceType.Microphone,
          silent: false,
        });
      } catch (error) {
        console.warn('Foreground service start failed:', error);
      }
    } catch {
      setMicAllowed(false);
      setStatusMsg('❌ Microphone permission denied. Please allow mic access and try again.');
      setPhase('join');
      return;
    }

    // Hash room if PIN is provided
    const effectiveRoom = await hashRoomWithPin(rawRoom, rawPin);
    setIsPinProtected(Boolean(rawPin));

    // 2. Connect WebSocket
    setStatusMsg('Connecting to signaling server...');
    const ws = new WebSocket(`${WS_BASE_URL}/ws/${effectiveRoom}/${encodeURIComponent(rawUser)}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatusMsg('Waiting for partner...');
      initPeerConnection(ws);
      setPhase('ready');
      void requestWakeLock();
    };

    ws.onerror = () => {
      setStatusMsg('❌ Cannot reach signaling server. Is the backend running?');
      setPhase('join');
      void cleanup();
    };

    ws.onclose = () => {
      if (phase === 'ready') {
        setConnState('disconnected');
        setStatusMsg('🔌 Disconnected from server.');
      }
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      await handleSignal(msg, ws);
    };
  };

  // ─── Peer Connection ─────────────────────────────────────────────────────
  const initPeerConnection = (ws: WebSocket) => {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pcRef.current = pc;

    // Add local tracks
    localStreamRef.current?.getTracks().forEach(t => {
      pc.addTrack(t, localStreamRef.current!);
    });

    // Remote audio
    pc.ontrack = (e) => {
      remoteStreamRef.current = e.streams[0];
      const audioEl = remoteAudioRef.current;
      if (audioEl) {
        audioEl.srcObject = e.streams[0];
        audioEl.play().catch(err => console.warn('Audio autoplay blocked:', err));
      }
    };

    // ICE candidates
    pc.onicecandidate = (e) => {
      if (e.candidate && ws.readyState === WebSocket.OPEN) {
        const targetId = peersRef.current[0];
        if (targetId) {
          ws.send(JSON.stringify({ type: 'ice-candidate', target_id: targetId, candidate: e.candidate }));
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') {
        setConnState('connected');
        setStatusMsg('🟢 Partner connected');
      } else if (s === 'disconnected' || s === 'failed' || s === 'closed') {
        setConnState('disconnected');
        setStatusMsg('⚠️ Partner disconnected');
        setPeers([]);
        setPartnerTelemetry(null);
      } else if (s === 'checking') {
        setConnState('connecting');
        setStatusMsg('🔄 Establishing P2P connection...');
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        setConnState('connected');
        setStatusMsg('🟢 Partner connected');
      }
    };

    pc.onnegotiationneeded = async () => {
      if (peersRef.current.length === 0) return;
      try {
        makingOfferRef.current = true;
        await pc.setLocalDescription();
        ws.send(JSON.stringify({ type: 'offer', target_id: peersRef.current[0], offer: pc.localDescription }));
      } catch (e) {
        console.error('Negotiation error:', e);
      } finally {
        makingOfferRef.current = false;
      }
    };

    return pc;
  };

  // ─── Signaling Message Handler ───────────────────────────────────────────
  const handleSignal = async (msg: Record<string, unknown>, ws: WebSocket) => {
    const pc = pcRef.current;

    if (msg.type === 'room_state') {
      const existingPeers = (msg.peers as string[]) ?? [];
      setPeers(existingPeers);
      politeRef.current = true;
      if (existingPeers.length > 0) {
        setStatusMsg('🔄 Partner found! Waiting for connection...');
      }
      return;
    }

    if (msg.type === 'peer_joined') {
      const newPeer = msg.user_id as string;
      if (!newPeer) return;
      setPeers(prev => [...prev, newPeer]);
      politeRef.current = false;
      setStatusMsg('🔄 Partner found! Establishing P2P...');

      if (pc) {
        try {
          makingOfferRef.current = true;
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          ws.send(JSON.stringify({ type: 'offer', target_id: newPeer, offer: pc.localDescription }));
        } catch (e) {
          console.error('Offer error:', e);
        } finally {
          makingOfferRef.current = false;
        }
      }
      return;
    }

    if (msg.type === 'peer_left') {
      setConnState('disconnected');
      setStatusMsg('⚠️ Partner left the room');
      setPeers(p => p.filter(id => id !== msg.user_id));
      setPartnerTelemetry(null);
      return;
    }

    // ── Telemetry Signal ──
    if (msg.type === 'telemetry') {
      setPartnerTelemetry({
        battery: typeof msg.battery === 'number' ? msg.battery : null,
        charging: typeof msg.charging === 'boolean' ? msg.charging : undefined,
        rttMs: typeof msg.rtt === 'number' ? msg.rtt : null,
      });
      return;
    }

    // ── Pager Buzzer Signal ──
    if (msg.type === 'buzzer') {
      playBuzzerSound();
      if (navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 300]);
      const sender = typeof msg.from_user === 'string' ? msg.from_user : 'Partner';
      setBuzzerAlert(`🚨 PAGING ALERT FROM ${sender.toUpperCase()}!`);
      setTimeout(() => setBuzzerAlert(null), 4500);
      return;
    }

    // ── PTT Signals (Half-Duplex Lock & Audio Feedback) ──
    if (msg.type === 'ptt_start') {
      setIsReceiving(true);
      triggerIncomingPing();
      playPttStartChirp();
      startRecordingIncoming();
      if (navigator.vibrate) navigator.vibrate([30, 50, 30]);
      return;
    }

    if (msg.type === 'ptt_end') {
      setIsReceiving(false);
      playTransmissionEnd();
      stopRecordingIncoming();
      return;
    }

    if (!pc) return;

    if (msg.type === 'offer') {
      const senderId = msg.from_user as string;
      if (senderId) {
        setPeers(prev => (prev.includes(senderId) ? prev : [...prev, senderId]));
        if (!peersRef.current.includes(senderId)) {
          peersRef.current = [...peersRef.current, senderId];
        }
      }

      const offerCollision = makingOfferRef.current || pc.signalingState !== 'stable';
      ignoreOfferRef.current = !politeRef.current && offerCollision;
      if (ignoreOfferRef.current) return;

      await pc.setRemoteDescription(new RTCSessionDescription(msg.offer as RTCSessionDescriptionInit));
      await flushIceCandidateQueue(pc);

      await pc.setLocalDescription();
      const targetId = senderId ?? peersRef.current[0];
      ws.send(JSON.stringify({ type: 'answer', target_id: targetId, answer: pc.localDescription }));
      return;
    }

    if (msg.type === 'answer') {
      if (pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription(new RTCSessionDescription(msg.answer as RTCSessionDescriptionInit));
      await flushIceCandidateQueue(pc);
      return;
    }

    if (msg.type === 'ice-candidate' && msg.candidate) {
      try {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate as RTCIceCandidateInit));
        } else {
          iceCandidateQueueRef.current.push(msg.candidate as RTCIceCandidateInit);
        }
      } catch (e) {
        if (!ignoreOfferRef.current) console.error('ICE error:', e);
      }
      return;
    }
  };

  const triggerIncomingPing = () => {
    setIncomingPing(true);
    if (pingTimeoutRef.current) clearTimeout(pingTimeoutRef.current);
    pingTimeoutRef.current = setTimeout(() => setIncomingPing(false), 1500);
  };

  // ─── Render: Join Screen ─────────────────────────────────────────────────
  if (phase === 'join' || phase === 'connecting') {
    return (
      <div className="app-shell">
        <div className="join-card">
          <div className="join-logo">
            <span className="join-icon">📻</span>
            <h1 className="join-title">Walkie<span className="accent">-</span>Talkie</h1>
            <p className="join-sub">Zero-lag P2P · Authentic radio audio · VOX &amp; Replay</p>
          </div>

          {micAllowed === false && (
            <div className="alert alert-danger">
              🎙 Microphone permission denied. Please allow access in browser settings and refresh.
            </div>
          )}

          <div className="form-group">
            <label className="form-label" htmlFor="room-id-input">Room Channel</label>
            <input
              id="room-id-input"
              className="form-input"
              type="text"
              placeholder="e.g. yash-radio"
              value={roomId}
              onChange={e => setRoomId(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && joinRoom()}
              disabled={phase === 'connecting'}
              autoCapitalize="none"
              autoCorrect="off"
            />
            <span className="form-hint">Both devices must enter the same Room Channel</span>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="room-pin-input">
              <span>Channel PIN</span>
              <span className="badge-optional">Optional</span>
            </label>
            <input
              id="room-pin-input"
              className="form-input"
              type="password"
              maxLength={8}
              placeholder="e.g. 1234 (Client-side hashed)"
              value={roomPin}
              onChange={e => setRoomPin(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && joinRoom()}
              disabled={phase === 'connecting'}
            />
            <span className="form-hint">Protects your channel from accidental intruders</span>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="user-id-input">Your Call Sign / Name</label>
            <input
              id="user-id-input"
              className="form-input"
              type="text"
              placeholder="e.g. Jo or Yash"
              value={userId}
              onChange={e => setUserId(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && joinRoom()}
              disabled={phase === 'connecting'}
              autoCapitalize="none"
              autoCorrect="off"
            />
          </div>

          <button
            id="join-btn"
            className="join-btn"
            onClick={joinRoom}
            disabled={phase === 'connecting' || !roomId.trim() || !userId.trim()}
          >
            {phase === 'connecting' ? (
              <><span className="spinner" /> Connecting Radio...</>
            ) : (
              '📡 Tune In / Join'
            )}
          </button>

          <p className="join-footer">
            Works across Android, iOS &amp; Desktop browsers. No app store required.
          </p>
        </div>
      </div>
    );
  }

  // ─── Render: Tactical PTT Screen ─────────────────────────────────────────
  const partnerName = peers[0] || null;

  return (
    <div className="app-shell">
      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />

      {/* Top Banner Alert (Buzzer) */}
      {buzzerAlert && (
        <div className="urgent-banner">
          <span className="urgent-icon">🚨</span>
          <span className="urgent-text">{buzzerAlert}</span>
        </div>
      )}

      {/* Header */}
      <header className="ptt-header">
        <div className="header-left">
          <span className="header-icon">📻</span>
          <div>
            <div className="header-title">Walkie-Talkie</div>
            <div className="header-room">
              CH: <strong>{roomId}</strong>
              {isPinProtected && <span className="pin-badge" title="PIN Protected">🔒</span>}
              {wakeLockActive && <span className="wakelock-badge" title="Screen WakeLock Active">⚡ Screen Awake</span>}
            </div>
          </div>
        </div>

        <div className="header-right">
          <div className={`status-chip status-${connState}`}>
            <span className="status-dot" />
            {connState === 'connected' ? 'Connected' : connState === 'connecting' ? 'Connecting' : 'Offline'}
          </div>
        </div>
      </header>

      {/* Main PTT area */}
      <main className="ptt-main">
        {/* Status message & Partner Telemetry */}
        <div className="status-banner">
          <p className="status-text">{statusMsg}</p>
          {partnerName && (
            <div className="telemetry-bar">
              <span className="partner-name">Partner: <strong>{partnerName}</strong></span>
              {partnerTelemetry && (
                <span className="telemetry-pill">
                  {partnerTelemetry.battery !== null && partnerTelemetry.battery !== undefined && (
                    <span className="telemetry-item">
                      {partnerTelemetry.battery}% {partnerTelemetry.charging ? '⚡' : '🔋'}
                    </span>
                  )}
                  {partnerTelemetry.rttMs !== null && partnerTelemetry.rttMs !== undefined && (
                    <span className="telemetry-item">
                      • {partnerTelemetry.rttMs}ms
                    </span>
                  )}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Channel Activity & Half-Duplex Lock Indicator */}
        <div className={`rx-indicator ${isReceiving ? 'rx-active' : ''} ${isTransmitting ? 'tx-active' : ''}`}>
          <div className="rx-bars">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className={`rx-bar rx-bar-${i}`} />
            ))}
          </div>
          <span className="rx-label">
            {isReceiving
              ? `🔴 RECEIVING FROM ${partnerName?.toUpperCase() || 'PARTNER'} (BUSY)`
              : isTransmitting
              ? '🟢 TRANSMITTING (AIRWAYS OCCUPIED)'
              : 'STANDBY / HALF-DUPLEX READY'}
          </span>
        </div>

        {/* PTT Main Button */}
        <div className="ptt-wrap">
          <div className={`ptt-ring ptt-ring-3 ${isTransmitting ? 'ring-active' : ''}`} />
          <div className={`ptt-ring ptt-ring-2 ${isTransmitting ? 'ring-active' : ''}`} />
          <div className={`ptt-ring ptt-ring-1 ${isTransmitting ? 'ring-active' : ''}`} />

          <button
            id="ptt-button"
            className={`ptt-btn ${isTransmitting ? 'ptt-tx' : ''} ${
              connState !== 'connected' || isReceiving ? 'ptt-disabled' : ''
            } ${incomingPing ? 'ptt-incoming' : ''} ${isReceiving ? 'ptt-locked' : ''}`}
            onMouseDown={handlePTTStart}
            onMouseUp={handlePTTEnd}
            onMouseLeave={isTransmitting ? handlePTTEnd : undefined}
            onTouchStart={e => {
              e.preventDefault();
              handlePTTStart();
            }}
            onTouchEnd={e => {
              e.preventDefault();
              handlePTTEnd();
            }}
            disabled={connState !== 'connected' || isReceiving}
            aria-label="Push to talk"
          >
            <span className="ptt-icon">
              {isReceiving ? '🔒' : isTransmitting ? '🎙' : '📡'}
            </span>
            <span className="ptt-label">
              {isReceiving
                ? 'CHANNEL BUSY'
                : isTransmitting
                ? 'TRANSMITTING'
                : connState !== 'connected'
                ? 'OFFLINE'
                : 'HOLD TO TALK'}
            </span>
            <span className="ptt-sublabel">
              {isReceiving ? 'Wait for partner to finish' : 'Spacebar or hold button'}
            </span>
          </button>
        </div>

        {/* Controls Toolbar: Buzzer, Replay, VOX */}
        <div className="action-toolbar">
          {/* 1-Tap Buzzer Button */}
          <button
            className="action-btn buzzer-btn"
            onClick={sendBuzzer}
            disabled={connState !== 'connected' || isReceiving}
            title="Send loud buzz paging alert to partner"
          >
            <span className="action-icon">⚡</span>
            <span>Buzz</span>
          </button>

          {/* Quick Replay Last Transmission */}
          <button
            className={`action-btn replay-btn ${replayClips.length > 0 ? 'has-clips' : ''} ${
              isPlayingReplay ? 'is-playing' : ''
            }`}
            onClick={() => replayClips[0] && handleTogglePlayReplay(replayClips[0])}
            disabled={replayClips.length === 0}
            title="Replay the last received voice transmission"
          >
            <span className="action-icon">{isPlayingReplay ? '⏹' : '⏪'}</span>
            <span>
              {isPlayingReplay
                ? 'Playing...'
                : replayClips[0]
                ? `Replay (${replayClips[0].durationSec}s)`
                : 'No Clutter'}
            </span>
          </button>

          {/* Hands-Free VOX Mode Toggle */}
          <button
            className={`action-btn vox-btn ${voxEnabled ? 'vox-active' : ''}`}
            onClick={() => setVoxEnabled(prev => !prev)}
            title="Voice-Activated Transmission (Hands-free)"
          >
            <span className="action-icon">{voxEnabled ? '🎙️' : '🔇'}</span>
            <span>VOX {voxEnabled ? 'ON' : 'OFF'}</span>
          </button>
        </div>

        {/* VOX Level Bar (when enabled) */}
        {voxEnabled && (
          <div className="vox-meter-container">
            <div className="vox-meter-label">
              <span>VOX Sensitivity</span>
              <span>{voxLevel}%</span>
            </div>
            <div className="vox-meter-track">
              <div
                className="vox-meter-fill"
                style={{
                  width: `${voxLevel}%`,
                  backgroundColor: voxLevel > 15 ? COLORS.success : COLORS.primary,
                }}
              />
              <div className="vox-meter-threshold" style={{ left: '15%' }} title="Trigger Threshold" />
            </div>
          </div>
        )}

        {/* Recent Transmissions History (Last 3) */}
        {replayClips.length > 1 && (
          <div className="replay-history">
            <span className="history-title">Recent Missed Audio:</span>
            <div className="history-list">
              {replayClips.map((clip, index) => (
                <button
                  key={clip.id}
                  className={`history-chip ${isPlayingReplay === clip.id ? 'chip-playing' : ''}`}
                  onClick={() => handleTogglePlayReplay(clip)}
                >
                  {isPlayingReplay === clip.id ? '⏹' : '▶'} #{index + 1} ({clip.durationSec}s at {clip.timeStr})
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Info footer */}
        <div className="ptt-info">
          <div className="info-chip">
            <span className="info-dot" style={{ background: COLORS.primary }} />
            You: <strong>{userId}</strong>
          </div>
          <button
            id="leave-btn"
            className="leave-btn"
            onClick={() => {
              void cleanup();
              setPhase('join');
              setConnState('disconnected');
              setPeers([]);
              setStatusMsg('');
              setPartnerTelemetry(null);
              setReplayClips([]);
            }}
          >
            Leave Room
          </button>
        </div>
      </main>
    </div>
  );
}
