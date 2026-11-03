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
import {
  deriveRoomKey,
  encryptSignal,
  decryptSignal,
  extractSdpFingerprint,
  computeSafetyNumber,
} from './crypto';
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

// ─── Helpers ─────────────────────────────────────────────────────────────────
const getDisplayName = (rawId: string | null | undefined): string => {
  if (!rawId) return '';
  return rawId.split('_')[0];
};

// ─── Main Component ──────────────────────────────────────────────────────────
export default function App() {
  const [phase, setPhase] = useState<AppPhase>('join');
  const [roomId, setRoomId] = useState('');
  const [roomPin, setRoomPin] = useState('');
  const [userId, setUserId] = useState('');
  const [isPinProtected, setIsPinProtected] = useState(false);
  const [connState, setConnState] = useState<ConnState>('disconnected');
  const [peers, setPeers] = useState<string[]>([]);

  // Cryptographic Key & Safety Number Verification
  const cryptoKeyRef = useRef<CryptoKey | null>(null);
  const [safetyBadge, setSafetyBadge] = useState<string | null>(null);
  const [showSafetyModal, setShowSafetyModal] = useState(false);

  // Video Calling State & Refs
  const [isLocalVideoActive, setIsLocalVideoActive] = useState(false);
  const isLocalVideoActiveRef = useRef(false);
  useEffect(() => {
    isLocalVideoActiveRef.current = isLocalVideoActive;
  }, [isLocalVideoActive]);

  const [isRemoteVideoActive, setIsRemoteVideoActive] = useState(false);
  const [isVideoMaximized, setIsVideoMaximized] = useState(false);
  const [isPipSwapped, setIsPipSwapped] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const videoSenderRef = useRef<RTCRtpSender | null>(null);
  const videoTransceiverRef = useRef<RTCRtpTransceiver | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const localVideoStreamRef = useRef<MediaStream | null>(null);
  const remoteVideoStreamRef = useRef<MediaStream | null>(null);

  // ─── Attach streams to video elements when video stage mounts ───────────
  useEffect(() => {
    if (remoteVideoRef.current && remoteVideoStreamRef.current) {
      if (remoteVideoRef.current.srcObject !== remoteVideoStreamRef.current) {
        remoteVideoRef.current.srcObject = remoteVideoStreamRef.current;
      }
      remoteVideoRef.current.play().catch(err => console.warn('Remote video play error:', err));
    }
    if (localVideoRef.current && localVideoStreamRef.current) {
      if (localVideoRef.current.srcObject !== localVideoStreamRef.current) {
        localVideoRef.current.srcObject = localVideoStreamRef.current;
      }
      localVideoRef.current.play().catch(err => console.warn('Local video play error:', err));
    }
  }, [isLocalVideoActive, isRemoteVideoActive, isPipSwapped, isVideoMaximized]);

  // ─── Hardware Frame Fallback Detector ───────────────────────────────────
  useEffect(() => {
    if (!isLocalVideoActive && !isRemoteVideoActive) return;

    const checkInterval = setInterval(() => {
      const videoEl = remoteVideoRef.current;
      if (videoEl && videoEl.videoWidth > 0 && !videoEl.paused) {
        setIsRemoteVideoActive(true);
      }
    }, 500);

    return () => clearInterval(checkInterval);
  }, [isLocalVideoActive, isRemoteVideoActive]);

  // ─── Escape Key to exit Maximized Video ──────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isVideoMaximized) {
        setIsVideoMaximized(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isVideoMaximized]);

  // Peers ref for WebRTC callbacks
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
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const remoteAudioStreamRef = useRef<MediaStream | null>(null);

  // VOX (Hands-Free Mode)
  const [voxEnabled, setVoxEnabled] = useState(false);
  const [voxLevel, setVoxLevel] = useState(0);
  const voxThreshold = 0.035;
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

  // WebRTC & Sockets
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const pingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const makingOfferRef = useRef(false);
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
      console.warn('Wake Lock request error:', e);
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

  // ─── Video Calling Functions ─────────────────────────────────────────────
  const getOrCreateVideoSender = useCallback((pc: RTCPeerConnection): RTCRtpSender => {
    const existing = pc.getTransceivers().find(
      t => t.receiver.track.kind === 'video' || t.sender.track?.kind === 'video'
    );
    if (existing) {
      existing.direction = 'sendrecv';
      videoTransceiverRef.current = existing;
      videoSenderRef.current = existing.sender;
      return existing.sender;
    }
    const transceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
    videoTransceiverRef.current = transceiver;
    videoSenderRef.current = transceiver.sender;
    return transceiver.sender;
  }, []);

  const startLocalVideo = useCallback(async (facing: 'user' | 'environment') => {
    try {
      // Stop any existing local video track first
      if (localVideoTrackRef.current) {
        localVideoTrackRef.current.stop();
        localVideoTrackRef.current = null;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: facing,
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
      });

      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) return;

      localVideoTrackRef.current = videoTrack;
      localVideoStreamRef.current = stream;

      const pc = pcRef.current;
      const activeSender = pc
        ? pc.getTransceivers().find(t => t.receiver.track.kind === 'video' || t.sender.track?.kind === 'video')?.sender || videoSenderRef.current
        : videoSenderRef.current;

      if (activeSender) {
        videoSenderRef.current = activeSender;
        await activeSender.replaceTrack(videoTrack);
      }

      setIsLocalVideoActive(true);

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.play().catch(e => console.warn('Local video play error:', e));
      }
    } catch (err) {
      console.warn('Local camera access failed (camera in use by another tab or unavailable):', err);
      // Gracefully handle dual-tab testing on a single PC or devices without cameras
      setStatusMsg('👁️ Viewing partner video (Local camera busy or unavailable)');
    }
  }, []);

  const stopLocalVideo = useCallback(async () => {
    if (localVideoTrackRef.current) {
      localVideoTrackRef.current.stop();
      localVideoTrackRef.current = null;
    }
    localVideoStreamRef.current = null;
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    const pc = pcRef.current;
    const activeSender = pc
      ? pc.getTransceivers().find(t => t.receiver.track.kind === 'video' || t.sender.track?.kind === 'video')?.sender || videoSenderRef.current
      : videoSenderRef.current;

    if (activeSender) {
      try {
        await activeSender.replaceTrack(null);
      } catch (e) {
        console.warn('replaceTrack null error:', e);
      }
    }
    setIsLocalVideoActive(false);
    setIsVideoMaximized(false);
    setIsPipSwapped(false);
  }, []);

  // ─── Encrypted Signaling Helper ──────────────────────────────────────────
  const sendEncryptedSignal = useCallback(async (payload: Record<string, unknown>, targetId?: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const target = targetId ?? peersRef.current[0];
    if (!target) return;

    if (cryptoKeyRef.current) {
      try {
        const { iv, ciphertext } = await encryptSignal(cryptoKeyRef.current, payload);
        ws.send(
          JSON.stringify({
            type: 'encrypted',
            target_id: target,
            iv,
            ciphertext,
          })
        );
        return;
      } catch (err) {
        console.error('Encryption dispatch error:', err);
      }
    }

    // Fallback unencrypted if key is not active
    ws.send(JSON.stringify({ ...payload, target_id: target }));
  }, []);

  // ─── Dual-Camera Toggle (User Initiated) ──────────────────────────────────
  const toggleVideo = async () => {
    if (connState !== 'connected' || peers.length === 0) return;

    if (!isLocalVideoActiveRef.current && !isRemoteVideoActive) {
      await startLocalVideo(facingMode);
      setIsRemoteVideoActive(true);
      await sendEncryptedSignal({ type: 'video_sync', state: 'on' });
    } else {
      await stopLocalVideo();
      setIsRemoteVideoActive(false);
      setIsVideoMaximized(false);
      setIsPipSwapped(false);
      await sendEncryptedSignal({ type: 'video_sync', state: 'off' });
    }
  };

  const flipCamera = async () => {
    const nextFacing = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(nextFacing);
    if (isLocalVideoActiveRef.current) {
      await startLocalVideo(nextFacing);
    }
  };

  // ─── Safety Badge Updater ────────────────────────────────────────────────
  const updateSafetyBadge = useCallback(async (pc: RTCPeerConnection) => {
    try {
      const localSdp = pc.localDescription?.sdp;
      const remoteSdp = pc.remoteDescription?.sdp;
      const localFp = extractSdpFingerprint(localSdp);
      const remoteFp = extractSdpFingerprint(remoteSdp);

      if (localFp && remoteFp) {
        const badge = await computeSafetyNumber(localFp, remoteFp);
        setSafetyBadge(badge);
      }
    } catch (e) {
      console.warn('Failed to compute safety badge:', e);
    }
  }, []);

  // ─── Reset Peer Connection Helper ─────────────────────────────────────────
  const resetPeerConnection = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.ontrack = null;
      pcRef.current.onicecandidate = null;
      pcRef.current.oniceconnectionstatechange = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.onnegotiationneeded = null;
      try {
        pcRef.current.close();
      } catch {}
      pcRef.current = null;
    }
    iceCandidateQueueRef.current = [];
    videoSenderRef.current = null;
    videoTransceiverRef.current = null;
  }, []);

  // ─── Cleanup ────────────────────────────────────────────────────────────
  const cleanup = useCallback(async () => {
    try {
      await ForegroundService.stopForegroundService();
    } catch (error) {
      console.warn('Foreground service stop failed:', error);
    }

    if (watchdogTimerRef.current) {
      clearTimeout(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
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

    await stopLocalVideo();
    await releaseWakeLock();

    resetPeerConnection();
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      wsRef.current.onopen = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    localStreamRef.current = null;
    remoteAudioStreamRef.current = null;
    localVideoStreamRef.current = null;
    remoteVideoStreamRef.current = null;
    cryptoKeyRef.current = null;
    setSafetyBadge(null);
  }, [releaseWakeLock, stopLocalVideo, resetPeerConnection]);

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
    if (!remoteAudioStreamRef.current || typeof MediaRecorder === 'undefined') return;
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
        ? new MediaRecorder(remoteAudioStreamRef.current, { mimeType })
        : new MediaRecorder(remoteAudioStreamRef.current);

      recorder.ondataavailable = e => {
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
            ...prev.slice(0, 2),
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
    if (connStateRef.current !== 'connected' || isReceivingRef.current || isTransmittingRef.current) {
      return;
    }
    setIsTransmitting(true);
    playPttStartChirp();

    localStreamRef.current?.getAudioTracks().forEach(t => (t.enabled = true));
    void sendEncryptedSignal({ type: 'ptt_start' });
    if (navigator.vibrate) navigator.vibrate(40);
  }, [sendEncryptedSignal]);

  const handlePTTEnd = useCallback(() => {
    if (!isTransmittingRef.current) return;
    setIsTransmitting(false);
    playTransmissionEnd();

    localStreamRef.current?.getAudioTracks().forEach(t => (t.enabled = false));
    void sendEncryptedSignal({ type: 'ptt_end' });
  }, [sendEncryptedSignal]);

  // ─── 1-Tap Buzzer / Paging Alert ─────────────────────────────────────────
  const sendBuzzer = () => {
    if (connState !== 'connected' || peers.length === 0) return;
    void sendEncryptedSignal({ type: 'buzzer' });
    playBuzzerSound();
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    setStatusMsg('⚡ Sent Buzz alert to partner!');
    setTimeout(() => {
      if (connStateRef.current === 'connected') {
        setStatusMsg('🟢 Partner connected');
      }
    }, 2500);
  };

  // ─── VOX Loop ────────────────────────────────────────────────────────────
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
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      voxAudioCtxRef.current = ctx;

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
        const percentage = Math.min(100, Math.round(rms * 400));
        setVoxLevel(percentage);

        if (rms >= voxThreshold) {
          if (!isTransmittingRef.current && !isReceivingRef.current && connStateRef.current === 'connected') {
            handlePTTStart();
          }
          if (voxSilenceTimerRef.current) {
            clearTimeout(voxSilenceTimerRef.current);
            voxSilenceTimerRef.current = null;
          }
        } else if (isTransmittingRef.current) {
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

  // ─── Hardware Spacebar & MediaSession PTT ─────────────────────────────────
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

    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: 'Sandcastle Walkie-Talkie',
          artist: `Channel: ${roomId}`,
          album: 'Encrypted Radio',
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

  // ─── Telemetry Gathering (Battery & RTT) ──────────────────────────────────
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

      void sendEncryptedSignal({
        type: 'telemetry',
        battery: batteryLevel,
        charging,
        rtt: rttMs,
      });
    };

    void reportTelemetry();
    telemetryTimerRef.current = setInterval(reportTelemetry, 10000);

    return () => {
      if (telemetryTimerRef.current) {
        clearInterval(telemetryTimerRef.current);
        telemetryTimerRef.current = null;
      }
    };
  }, [phase, connState, sendEncryptedSignal]);

  // ─── Incoming Ping Visualizer ───────────────────────────────────────────
  const triggerIncomingPing = useCallback(() => {
    setIncomingPing(true);
    if (pingTimeoutRef.current) clearTimeout(pingTimeoutRef.current);
    pingTimeoutRef.current = setTimeout(() => setIncomingPing(false), 1500);
  }, []);

  // ─── Peer Connection & Video Transceiver Initialization ───────────────────
  const initPeerConnection = useCallback((ws: WebSocket) => {
    // If an existing PC is still open, tear it down cleanly first
    if (pcRef.current) {
      pcRef.current.ontrack = null;
      pcRef.current.onicecandidate = null;
      pcRef.current.oniceconnectionstatechange = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.onnegotiationneeded = null;
      try {
        pcRef.current.close();
      } catch {}
      pcRef.current = null;
    }
    iceCandidateQueueRef.current = [];
    videoSenderRef.current = null;
    videoTransceiverRef.current = null;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    pcRef.current = pc;

    // Add local audio tracks (keeps mic stream alive)
    localStreamRef.current?.getTracks().forEach(t => {
      pc.addTrack(t, localStreamRef.current!);
    });

    // If local camera is already active, wire it into the fresh peer connection
    if (localVideoTrackRef.current) {
      const sender = getOrCreateVideoSender(pc);
      void sender.replaceTrack(localVideoTrackRef.current);
    }

    // Remote audio & video streams
    pc.ontrack = e => {
      if (e.track.kind === 'audio') {
        remoteAudioStreamRef.current = e.streams[0];
        const audioEl = remoteAudioRef.current;
        if (audioEl) {
          audioEl.srcObject = e.streams[0];
          audioEl.play().catch(err => console.warn('Audio autoplay blocked:', err));
        }
      } else if (e.track.kind === 'video') {
        const stream = (e.streams && e.streams[0]) ? e.streams[0] : new MediaStream([e.track]);
        remoteVideoStreamRef.current = stream;
        setIsRemoteVideoActive(true);

        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = stream;
          remoteVideoRef.current.play().catch(err => console.warn('Remote video play blocked:', err));
        }

        e.track.onunmute = () => {
          setIsRemoteVideoActive(true);
          if (remoteVideoRef.current) {
            if (remoteVideoRef.current.srcObject !== remoteVideoStreamRef.current) {
              remoteVideoRef.current.srcObject = remoteVideoStreamRef.current;
            }
            remoteVideoRef.current.play().catch(() => {});
          }
        };

        e.track.onended = () => {
          setIsRemoteVideoActive(false);
        };
      }
    };

    // ICE candidates (sent encrypted)
    pc.onicecandidate = e => {
      if (e.candidate && ws.readyState === WebSocket.OPEN) {
        const targetId = peersRef.current[0];
        if (targetId) {
          void sendEncryptedSignal({ type: 'ice-candidate', candidate: e.candidate }, targetId);
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') {
        setConnState('connected');
        setStatusMsg('🟢 Partner connected');
        void updateSafetyBadge(pc);
      } else if (s === 'checking') {
        setConnState('connecting');
        setStatusMsg('🔄 Establishing authenticated P2P...');
      } else if (s === 'disconnected') {
        setConnState('connecting');
        setStatusMsg('📡 Reconnecting audio stream...');
      } else if (s === 'failed') {
        setConnState('disconnected');
        setStatusMsg('⚠️ Audio link interrupted. Reconnecting...');
        if (politeRef.current && ws.readyState === WebSocket.OPEN && peersRef.current[0]) {
          void sendEncryptedSignal({ type: 'renegotiate' }, peersRef.current[0]);
        }
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        setConnState('connected');
        setStatusMsg('🟢 Partner connected');
        void updateSafetyBadge(pc);
      } else if (s === 'connecting') {
        setConnState('connecting');
      } else if (s === 'disconnected') {
        setConnState('connecting');
        setStatusMsg('📡 Reconnecting audio stream...');
      } else if (s === 'failed') {
        setConnState('disconnected');
        setStatusMsg('⚠️ Audio link interrupted. Reconnecting...');
        if (politeRef.current && ws.readyState === WebSocket.OPEN && peersRef.current[0]) {
          void sendEncryptedSignal({ type: 'renegotiate' }, peersRef.current[0]);
        }
      }
    };

    pc.onnegotiationneeded = async () => {
      if (peersRef.current.length === 0) return;
      try {
        makingOfferRef.current = true;
        getOrCreateVideoSender(pc);
        await pc.setLocalDescription();
        void updateSafetyBadge(pc);
        await sendEncryptedSignal(
          { type: 'offer', offer: pc.localDescription },
          peersRef.current[0]
        );
      } catch (e) {
        console.error('Negotiation error:', e);
      } finally {
        makingOfferRef.current = false;
      }
    };

    return pc;
  }, [getOrCreateVideoSender, sendEncryptedSignal, updateSafetyBadge]);

  // ─── Signaling Message Handler ───────────────────────────────────────────
  const handleSignal = async (msg: Record<string, unknown>, ws: WebSocket) => {
    // ── Room State (Existing peers already in channel) ──
    if (msg.type === 'room_state') {
      const existingPeers = (msg.peers as string[]) ?? [];
      setPeers(existingPeers);
      politeRef.current = true;
      if (existingPeers.length > 0) {
        setStatusMsg('🔄 Partner found! Negotiating cipher & session...');
        // New joiner initiates offer to the existing peer
        const targetPeer = existingPeers[0];
        resetPeerConnection();
        const pc = initPeerConnection(ws);
        try {
          makingOfferRef.current = true;
          getOrCreateVideoSender(pc);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          void updateSafetyBadge(pc);
          await sendEncryptedSignal({ type: 'offer', offer: pc.localDescription }, targetPeer);
        } catch (e) {
          console.error('Initial offer error:', e);
        } finally {
          makingOfferRef.current = false;
        }
      }
      return;
    }

    // ── Peer Joined (New peer arrived) ──
    if (msg.type === 'peer_joined') {
      const newPeer = msg.user_id as string;
      if (!newPeer) return;
      setPeers(prev => (prev.includes(newPeer) ? prev : [...prev, newPeer]));
      politeRef.current = false;
      setStatusMsg('🔄 Partner found! Waiting for cipher handshake...');
      // Existing peer resets PC and waits for newcomer's offer (avoids glare)
      resetPeerConnection();
      initPeerConnection(ws);
      return;
    }

    // ── Peer Left ──
    if (msg.type === 'peer_left') {
      setConnState('disconnected');
      setStatusMsg('⚠️ Partner left the channel');
      setPeers(p => p.filter(id => id !== msg.user_id));
      setPartnerTelemetry(null);
      setSafetyBadge(null);
      setIsRemoteVideoActive(false);
      resetPeerConnection();
      return;
    }

    // ── Request Offer / Renegotiate ──
    if (msg.type === 'request_offer' || msg.type === 'renegotiate') {
      const targetId = (msg.from_user as string) || peersRef.current[0];
      if (targetId) {
        resetPeerConnection();
        const pc = initPeerConnection(ws);
        try {
          makingOfferRef.current = true;
          getOrCreateVideoSender(pc);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          void updateSafetyBadge(pc);
          await sendEncryptedSignal({ type: 'offer', offer: pc.localDescription }, targetId);
        } catch (e) {
          console.warn('Renegotiate offer error:', e);
        } finally {
          makingOfferRef.current = false;
        }
      }
      return;
    }

    // ── Offer ──
    if (msg.type === 'offer') {
      const senderId = msg.from_user as string;
      if (senderId) {
        setPeers(prev => (prev.includes(senderId) ? prev : [...prev, senderId]));
        if (!peersRef.current.includes(senderId)) {
          peersRef.current = [...peersRef.current, senderId];
        }
      }

      // Always reset and create fresh PeerConnection to accept incoming offer cleanly
      resetPeerConnection();
      const pc = initPeerConnection(ws);

      await pc.setRemoteDescription(new RTCSessionDescription(msg.offer as RTCSessionDescriptionInit));
      await flushIceCandidateQueue(pc);
      void updateSafetyBadge(pc);

      // Reuse the video transceiver created/matched by setRemoteDescription(offer)
      const videoTransceiver = pc.getTransceivers().find(
        t => t.receiver.track.kind === 'video' || t.sender.track?.kind === 'video'
      );
      if (videoTransceiver) {
        videoTransceiver.direction = 'sendrecv';
        videoTransceiverRef.current = videoTransceiver;
        videoSenderRef.current = videoTransceiver.sender;
      }

      await pc.setLocalDescription();
      void updateSafetyBadge(pc);

      const targetId = senderId ?? peersRef.current[0];
      await sendEncryptedSignal({ type: 'answer', answer: pc.localDescription }, targetId);
      return;
    }

    // ── Answer ──
    if (msg.type === 'answer') {
      const pc = pcRef.current;
      if (!pc || pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription(new RTCSessionDescription(msg.answer as RTCSessionDescriptionInit));
      await flushIceCandidateQueue(pc);
      void updateSafetyBadge(pc);
      return;
    }

    // ── ICE Candidate ──
    if (msg.type === 'ice-candidate' && msg.candidate) {
      const pc = pcRef.current;
      try {
        if (pc && pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate as RTCIceCandidateInit));
        } else {
          iceCandidateQueueRef.current.push(msg.candidate as RTCIceCandidateInit);
        }
      } catch (e) {
        console.warn('ICE candidate error:', e);
      }
      return;
    }

    // ── Video Sync Signal (Dual Camera Auto Turn On / Off) ──
    if (msg.type === 'video_sync') {
      const desiredState = msg.state as string;
      const isAck = Boolean(msg.isAck);

      if (desiredState === 'on') {
        setIsRemoteVideoActive(true);
        if (!isLocalVideoActiveRef.current) {
          void startLocalVideo('user');
        }
        if (!isAck) {
          // Echo acknowledgment back so both peers guarantee isRemoteVideoActive = true
          void sendEncryptedSignal({ type: 'video_sync', state: 'on', isAck: true });
        }
      } else if (desiredState === 'off') {
        setIsRemoteVideoActive(false);
        setIsVideoMaximized(false);
        setIsPipSwapped(false);
        if (isLocalVideoActiveRef.current) {
          void stopLocalVideo();
        }
      }
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
      const sender = typeof msg.from_user === 'string' ? getDisplayName(msg.from_user) : 'Partner';
      setBuzzerAlert(`🚨 PAGING ALERT FROM ${sender.toUpperCase()}!`);
      setTimeout(() => setBuzzerAlert(null), 4500);
      return;
    }

    // ── PTT Signals ──
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

    if (msg.type === 'error') {
      const errMsg = typeof msg.message === 'string' ? msg.message : '';
      if (errMsg.toLowerCase().includes('already in use') || errMsg.toLowerCase().includes('different name')) {
        return;
      }
      setStatusMsg(`❌ ${errMsg || 'Relay error'}`);
      return;
    }
  };

  // ─── Join Room ──────────────────────────────────────────────────────────
  const joinRoom = async () => {
    const rawRoom = roomId.trim();
    const rawUser = userId.trim();
    const rawPin = roomPin.trim();
    if (!rawRoom || !rawUser) return;

    setPhase('connecting');
    setStatusMsg('Deriving AES-256 E2EE key...');

    // 1. Derive PBKDF2 Client-Side Encryption Key
    try {
      cryptoKeyRef.current = await deriveRoomKey(rawRoom, rawPin);
    } catch (e) {
      console.warn('Key derivation error:', e);
    }

    // 2. Request mic
    setStatusMsg('Requesting microphone permission...');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      stream.getAudioTracks().forEach(t => (t.enabled = false));
      localStreamRef.current = stream;
      setMicAllowed(true);

      try {
        await ForegroundService.createNotificationChannel({
          id: 'walkie_talkie_channel',
          name: 'Walkie Talkie',
          description: 'Background service for Sandcastle Walkie-Talkie',
          importance: Importance.Default,
        });

        await ForegroundService.startForegroundService({
          id: 5001,
          title: 'Sandcastle Walkie-Talkie',
          body: `Channel: ${rawRoom}`,
          smallIcon: 'ic_launcher_background',
          notificationChannelId: 'walkie_talkie_channel',
          serviceType: ServiceType.Microphone,
          silent: false,
        });
      } catch (error) {
        console.warn('Foreground service error:', error);
      }
    } catch {
      setMicAllowed(false);
      setStatusMsg('❌ Microphone permission denied. Please allow access and refresh.');
      setPhase('join');
      return;
    }

    const effectiveRoom = await hashRoomWithPin(rawRoom, rawPin);
    setIsPinProtected(Boolean(rawPin));

    // Guard against duplicate connection if already connecting or open for this session
    if (wsRef.current && (wsRef.current.readyState === WebSocket.CONNECTING || wsRef.current.readyState === WebSocket.OPEN)) {
      console.log('WebSocket already active for this session, skipping duplicate join.');
      return;
    }

    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      wsRef.current.onopen = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    // 3. Connect WebSocket (using sessionStorage for per-tab isolation)
    setStatusMsg('Connecting to encrypted channel relay...');
    let deviceId = '';
    try {
      deviceId = sessionStorage.getItem('deviceId') || '';
      if (!deviceId) {
        deviceId = Math.random().toString(36).substring(2, 6);
        sessionStorage.setItem('deviceId', deviceId);
      }
    } catch {
      deviceId = Math.random().toString(36).substring(2, 6);
    }
    const socketUserId = `${rawUser}_${deviceId}`;
    const ws = new WebSocket(`${WS_BASE_URL}/ws/${effectiveRoom}/${encodeURIComponent(socketUserId)}`);
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws) return;
      setStatusMsg('Waiting for partner on channel...');
      initPeerConnection(ws);
      setPhase('ready');
      void requestWakeLock();
    };

    ws.onerror = () => {
      if (wsRef.current !== ws) return;
      setStatusMsg('❌ Cannot reach signaling server. Is the relay reachable?');
      setPhase('join');
      void cleanup();
    };

    ws.onclose = (event: CloseEvent) => {
      if (wsRef.current !== ws) return;
      if (event.code === 4000) {
        // Socket was intentionally replaced by another connection for this session
        return;
      }
      if (phase === 'ready') {
        setConnState('disconnected');
        setStatusMsg('🔌 Disconnected from channel.');
      }
    };

    ws.onmessage = async event => {
      if (wsRef.current !== ws) return;
      try {
        const rawMsg = JSON.parse(event.data);
        let msg = rawMsg;

        // Decrypt end-to-end signal if payload is encrypted envelope
        if (rawMsg.type === 'encrypted' && rawMsg.iv && rawMsg.ciphertext && cryptoKeyRef.current) {
          try {
            const decrypted = (await decryptSignal(
              cryptoKeyRef.current,
              rawMsg.iv,
              rawMsg.ciphertext
            )) as Record<string, unknown>;
            msg = {
              ...decrypted,
              from_user: rawMsg.from_user,
              target_id: rawMsg.target_id,
            };
          } catch (decErr) {
            console.warn('Decryption failed (Secret Key mismatch):', decErr);
            setStatusMsg('🔒 Received signal with mismatched Secret Key / PIN.');
            return;
          }
        }

        await handleSignal(msg, ws);
      } catch (err) {
        console.error('Signal parsing error:', err);
      }
    };
  };

  // ─── 12-Second Handshake Watchdog (Auto-Healing) ───────────────────────
  useEffect(() => {
    if (phase !== 'ready' || peers.length === 0 || connState === 'connected') {
      if (watchdogTimerRef.current) {
        clearTimeout(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }
      return;
    }

    watchdogTimerRef.current = setTimeout(async () => {
      const ws = wsRef.current;
      const target = peersRef.current[0];
      if (connStateRef.current !== 'connected' && target && ws && ws.readyState === WebSocket.OPEN && politeRef.current) {
        console.warn('⚡ Handshake watchdog: requesting renegotiation from partner...');
        setStatusMsg('🔄 Retrying authenticated handshake...');
        void sendEncryptedSignal({ type: 'renegotiate' }, target);
      }
    }, 12000);

    return () => {
      if (watchdogTimerRef.current) {
        clearTimeout(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }
    };
  }, [phase, peers, connState, sendEncryptedSignal]);

  // ─── Render: Join Screen (Sandcastle Theme) ──────────────────────────────
  if (phase === 'join' || phase === 'connecting') {
    return (
      <div className="sc-app-shell">
        <div className="sc-join-card">
          <div className="sc-brand-header">
            <div className="sc-brand-dots">
              <span className="sc-dot sc-dot-olive" />
              <span className="sc-dot sc-dot-terracotta" />
              <span className="sc-brand-text">SANDCASTLE</span>
            </div>
            <div className="sc-brand-eyebrow">
              FOR PRIVATE TEAMS &amp; SECURE FIELD CHANNELS
            </div>
            <h1 className="sc-join-headline">
              Encrypted Walkie-Talkie <span className="sc-accent-underline">&amp; Dual-Camera.</span>
            </h1>
            <p className="sc-join-sub">
              Zero-server storage · Native AES-GCM 256-bit E2EE · Tap to open both cameras simultaneously.
            </p>
          </div>

          {micAllowed === false && (
            <div className="sc-alert sc-alert-danger">
              🎙 Microphone permission denied. Please allow microphone and camera in your browser settings.
            </div>
          )}

          <div className="sc-form-group">
            <label className="sc-form-label" htmlFor="room-id-input">
              Channel Identifier
            </label>
            <input
              id="room-id-input"
              className="sc-form-input"
              type="text"
              placeholder="e.g. security-alpha"
              value={roomId}
              onChange={e => setRoomId(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && joinRoom()}
              disabled={phase === 'connecting'}
              autoCapitalize="none"
              autoCorrect="off"
            />
            <span className="sc-form-hint">Both devices must enter the exact same Channel Identifier</span>
          </div>

          <div className="sc-form-group">
            <label className="sc-form-label" htmlFor="room-pin-input">
              <span>Secret PIN / AES Key</span>
              <span className="sc-badge-optional">Optional (PBKDF2)</span>
            </label>
            <input
              id="room-pin-input"
              className="sc-form-input"
              type="password"
              placeholder="e.g. 8492 (Derives 256-bit AES-GCM key)"
              value={roomPin}
              onChange={e => setRoomPin(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && joinRoom()}
              disabled={phase === 'connecting'}
            />
            <span className="sc-form-hint">Used client-side to derive your E2EE key. Never sent to the server.</span>
          </div>

          <div className="sc-form-group">
            <label className="sc-form-label" htmlFor="user-id-input">
              Your Call Sign
            </label>
            <input
              id="user-id-input"
              className="sc-form-input"
              type="text"
              placeholder="e.g. Yash (PC) or Priya (Mobile)"
              value={userId}
              onChange={e => setUserId(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && joinRoom()}
              disabled={phase === 'connecting'}
              autoCapitalize="none"
              autoCorrect="off"
            />
            <span className="sc-form-hint">Your callsign for this channel (e.g. pilot, base, yash).</span>
          </div>

          <button
            id="join-btn"
            className="sc-btn-primary"
            onClick={joinRoom}
            disabled={phase === 'connecting' || !roomId.trim() || !userId.trim()}
          >
            {phase === 'connecting' ? (
              <><span className="sc-spinner" /> Establishing Encrypted Link...</>
            ) : (
              'Tune In Channel →'
            )}
          </button>

          <div className="sc-join-footer">
            <span>🛡️ End-to-End Encrypted via native WebCrypto</span>
            <span>Zero accounts · Works on Android, iOS &amp; Desktop</span>
          </div>
        </div>
      </div>
    );
  }

  // ─── Render: Tactical PTT Screen (Sandcastle Theme) ──────────────────────
  const partnerName = peers[0] ? getDisplayName(peers[0]) : null;

  return (
    <div className="sc-app-shell">
      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />

      {/* Safety Number Verification Modal */}
      {showSafetyModal && (
        <div className="sc-modal-backdrop" onClick={() => setShowSafetyModal(false)}>
          <div className="sc-modal-card" onClick={e => e.stopPropagation()}>
            <div className="sc-modal-header">
              <span className="sc-modal-title">🔐 P2P Safety Number Verification</span>
              <button className="sc-modal-close" onClick={() => setShowSafetyModal(false)}>✕</button>
            </div>
            <p className="sc-modal-desc">
              Compare this 4-emoji Safety Number with your partner’s screen. If both match, your connection is verified and mathematically immune to eavesdroppers:
            </p>
            <div className="sc-safety-banner">
              <span className="sc-safety-emojis-lg">{safetyBadge || '🔒 Negotiating...'}</span>
              <span className="sc-safety-status-lg">AUTHENTICATED DTLS-SRTP FINGERPRINTS</span>
            </div>
            <div className="sc-modal-details">
              <div><strong>Channel:</strong> {roomId}</div>
              <div><strong>Cipher:</strong> AES-GCM 256-bit (PBKDF2 SHA-256)</div>
              <div><strong>Partner:</strong> {partnerName || 'Waiting...'}</div>
            </div>
            <button className="sc-btn-primary" onClick={() => setShowSafetyModal(false)}>
              Verified &amp; Close
            </button>
          </div>
        </div>
      )}

      {/* Top Banner Alert (Buzzer) */}
      {buzzerAlert && (
        <div className="sc-urgent-banner">
          <span className="sc-urgent-icon">🚨</span>
          <span>{buzzerAlert}</span>
        </div>
      )}

      {/* Header */}
      <header className="sc-ptt-header">
        <div className="sc-header-left">
          <div className="sc-brand-dots">
            <span className="sc-dot sc-dot-olive" />
            <span className="sc-dot sc-dot-terracotta" />
            <span className="sc-brand-text">SANDCASTLE</span>
          </div>
          <div className="sc-channel-meta">
            <span className="sc-channel-name">CH: <strong>{roomId}</strong></span>
            {isPinProtected && <span className="sc-badge-pin" title="AES-GCM Protected">🔒</span>}
            {wakeLockActive && <span className="sc-badge-wake" title="Screen WakeLock Active">⚡</span>}
          </div>
        </div>

        <div className="sc-header-right">
          {safetyBadge && (
            <button
              className="sc-safety-badge"
              onClick={() => setShowSafetyModal(true)}
              title="Click to verify End-to-End Encryption Safety Number"
            >
              <span className="sc-safety-badge-emojis">{safetyBadge}</span>
              <span className="sc-safety-badge-label sc-hide-mobile">Verified</span>
            </button>
          )}

          <div className={`sc-status-chip sc-status-${connState}`} title={`Status: ${connState}`}>
            <span className="sc-status-dot" />
            <span className="sc-status-text-pill">{connState === 'connected' ? 'Connected' : connState === 'connecting' ? 'Connecting' : 'Offline'}</span>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="sc-ptt-main">
        {/* Dual-Camera Video Stage (when either camera is active) */}
        {(isLocalVideoActive || isRemoteVideoActive) && (
          <div className={`sc-video-stage ${isVideoMaximized ? 'sc-video-maximized' : ''}`}>
            {/* Primary Feed (Remote by default, or Local when PiP swapped) */}
            <div
              className={`sc-video-feed-wrapper ${!isPipSwapped ? 'sc-feed-main' : 'sc-feed-pip'}`}
              onClick={isPipSwapped ? () => setIsPipSwapped(false) : undefined}
              onDoubleClick={() => setIsVideoMaximized(prev => !prev)}
              title={isPipSwapped ? 'Tap to expand remote partner' : 'Double-click to toggle fullscreen'}
            >
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                onLoadedData={() => {
                  if (remoteVideoRef.current && remoteVideoRef.current.videoWidth > 0) {
                    setIsRemoteVideoActive(true);
                  }
                }}
                onPlaying={() => {
                  if (remoteVideoRef.current && remoteVideoRef.current.videoWidth > 0) {
                    setIsRemoteVideoActive(true);
                  }
                }}
                onResize={() => {
                  if (remoteVideoRef.current && remoteVideoRef.current.videoWidth > 0) {
                    setIsRemoteVideoActive(true);
                  }
                }}
                className={`sc-video-element ${!isRemoteVideoActive ? 'sc-video-waiting' : ''}`}
              />
              {!isRemoteVideoActive && (
                <div className="sc-video-waiting-overlay">
                  <span className="sc-spinner" />
                  <span>Waiting for partner video...</span>
                </div>
              )}
              {isPipSwapped && <span className="sc-pip-tag">Partner</span>}
            </div>

            {/* Secondary Feed (Local self-view by default, or Remote when PiP swapped) */}
            {isLocalVideoActive && (
              <div
                className={`sc-video-feed-wrapper ${!isPipSwapped ? 'sc-feed-pip' : 'sc-feed-main'}`}
                onClick={!isPipSwapped ? () => setIsPipSwapped(true) : undefined}
                onDoubleClick={() => setIsVideoMaximized(prev => !prev)}
                title={!isPipSwapped ? 'Tap to expand your camera' : 'Double-click to toggle fullscreen'}
              >
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="sc-video-element sc-video-selfie"
                />
                {!isPipSwapped && <span className="sc-pip-tag">You</span>}
                <button
                  className="sc-pip-flip-btn"
                  onClick={e => {
                    e.stopPropagation();
                    void flipCamera();
                  }}
                  title="Flip front/rear camera"
                >
                  🔄
                </button>
              </div>
            )}

            {/* Video Stage Top Overlay */}
            <div className="sc-video-overlay-bar">
              <span className="sc-video-live-pill">
                <span className="sc-live-dot" />
                {isLocalVideoActive && isRemoteVideoActive
                  ? 'Both Cameras Live'
                  : isRemoteVideoActive
                  ? 'Partner Video Live'
                  : 'Streaming Camera'}
              </span>

              <div className="sc-video-top-actions" onClick={e => e.stopPropagation()}>
                <button
                  className="sc-video-btn-pill"
                  onClick={e => {
                    e.stopPropagation();
                    setIsVideoMaximized(prev => !prev);
                  }}
                  title={isVideoMaximized ? 'Minimize Video (Esc)' : 'Maximize Video'}
                >
                  {isVideoMaximized ? '🗗 Minimize' : '⛶ Maximize'}
                </button>
                <button
                  className="sc-video-end-btn"
                  onClick={e => {
                    e.stopPropagation();
                    void toggleVideo();
                  }}
                  title="Turn off video"
                >
                  ✕ Stop
                </button>
              </div>
            </div>

            {/* Floating PTT Bar inside Fullscreen / Maximized Mode */}
            {isVideoMaximized && (
              <div className="sc-maximized-floating-bar">
                <button
                  className={`sc-maximized-ptt-btn ${isTransmitting ? 'sc-ptt-tx' : ''} ${
                    connState !== 'connected' || isReceiving ? 'sc-ptt-disabled' : ''
                  } ${isReceiving ? 'sc-ptt-locked' : ''}`}
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
                  <span className="sc-max-ptt-icon">{isReceiving ? '🔒' : isTransmitting ? '🎙️' : '📡'}</span>
                  <span className="sc-max-ptt-text">
                    {isReceiving ? 'RECEIVING...' : isTransmitting ? 'TRANSMITTING' : 'HOLD TO TALK'}
                  </span>
                </button>

                <div className="sc-maximized-quick-actions">
                  {isLocalVideoActive && (
                    <button
                      className="sc-max-icon-btn"
                      onClick={() => void flipCamera()}
                      title="Flip front/rear camera"
                    >
                      🔄
                    </button>
                  )}
                  <button
                    className="sc-max-icon-btn"
                    onClick={() => setIsVideoMaximized(false)}
                    title="Exit Fullscreen (Esc)"
                  >
                    🗗
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Status banner & Telemetry */}
        <div className="sc-status-banner">
          <p className="sc-status-text">{statusMsg}</p>
          {partnerName && (
            <div className="sc-telemetry-bar">
              <span>Partner: <strong>{partnerName}</strong></span>
              {partnerTelemetry && (
                <span className="sc-telemetry-pill">
                  {partnerTelemetry.battery !== null && partnerTelemetry.battery !== undefined && (
                    <span>{partnerTelemetry.battery}% {partnerTelemetry.charging ? '⚡' : '🔋'}</span>
                  )}
                  {partnerTelemetry.rttMs !== null && partnerTelemetry.rttMs !== undefined && (
                    <span>• {partnerTelemetry.rttMs}ms RTT</span>
                  )}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Channel Activity & Half-Duplex Lock Indicator */}
        <div className={`sc-rx-indicator ${isReceiving ? 'sc-rx-active' : ''} ${isTransmitting ? 'sc-tx-active' : ''}`}>
          <div className="sc-rx-bars">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className={`sc-rx-bar sc-rx-bar-${i}`} />
            ))}
          </div>
          <span className="sc-rx-label">
            {isReceiving
              ? `🔴 RECEIVING FROM ${partnerName?.toUpperCase() || 'PARTNER'} (CHANNEL BUSY)`
              : isTransmitting
              ? '🟢 TRANSMITTING (AIRWAYS OCCUPIED)'
              : 'HALF-DUPLEX READY • STANDBY'}
          </span>
        </div>

        {/* Central Tactile PTT Button */}
        <div className="sc-ptt-wrap">
          <div className={`sc-ptt-ring sc-ptt-ring-3 ${isTransmitting ? 'sc-ring-active' : ''}`} />
          <div className={`sc-ptt-ring sc-ptt-ring-2 ${isTransmitting ? 'sc-ring-active' : ''}`} />
          <div className={`sc-ptt-ring sc-ptt-ring-1 ${isTransmitting ? 'sc-ring-active' : ''}`} />

          <button
            id="ptt-button"
            className={`sc-ptt-btn ${isTransmitting ? 'sc-ptt-tx' : ''} ${
              connState !== 'connected' || isReceiving ? 'sc-ptt-disabled' : ''
            } ${incomingPing ? 'sc-ptt-incoming' : ''} ${isReceiving ? 'sc-ptt-locked' : ''}`}
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
            <span className="sc-ptt-icon">
              {isReceiving ? '🔒' : isTransmitting ? '🎙️' : '📡'}
            </span>
            <span className="sc-ptt-label">
              {isReceiving
                ? 'CHANNEL BUSY'
                : isTransmitting
                ? 'TRANSMITTING'
                : connState !== 'connected'
                ? 'OFFLINE'
                : 'HOLD TO TALK'}
            </span>
            <span className="sc-ptt-sublabel">
              {isReceiving ? 'Wait for partner to release' : 'Spacebar or hold button'}
            </span>
          </button>
        </div>

        {/* Uber-Style Accessible Controls Grid */}
        <div className="sc-action-grid">
          {/* Dual-Camera Toggle Button */}
          <button
            className={`sc-action-tile sc-video-tile ${(isLocalVideoActive || isRemoteVideoActive) ? 'sc-tile-active-terracotta' : ''}`}
            onClick={toggleVideo}
            disabled={connState !== 'connected'}
            title="Turn on both cameras simultaneously"
          >
            <span className="sc-tile-icon">{(isLocalVideoActive || isRemoteVideoActive) ? '📹' : '📷'}</span>
            <div className="sc-tile-info">
              <span className="sc-tile-title">{(isLocalVideoActive || isRemoteVideoActive) ? 'Stop Video' : 'Video Call'}</span>
              <span className="sc-tile-sub">{(isLocalVideoActive || isRemoteVideoActive) ? 'Video Live' : 'Both cameras'}</span>
            </div>
          </button>

          {/* 1-Tap Buzzer Button */}
          <button
            className="sc-action-tile sc-buzzer-tile"
            onClick={sendBuzzer}
            disabled={connState !== 'connected' || isReceiving}
            title="Send loud buzz paging alert to partner"
          >
            <span className="sc-tile-icon">⚡</span>
            <div className="sc-tile-info">
              <span className="sc-tile-title">Buzz Alert</span>
              <span className="sc-tile-sub">Loud page</span>
            </div>
          </button>

          {/* Quick Replay Last Transmission */}
          <button
            className={`sc-action-tile sc-replay-tile ${replayClips.length > 0 ? 'sc-has-clips' : ''} ${
              isPlayingReplay ? 'sc-is-playing' : ''
            }`}
            onClick={() => replayClips[0] && handleTogglePlayReplay(replayClips[0])}
            disabled={replayClips.length === 0}
            title="Replay the last received voice transmission"
          >
            <span className="sc-tile-icon">{isPlayingReplay ? '⏹' : '⏪'}</span>
            <div className="sc-tile-info">
              <span className="sc-tile-title">{isPlayingReplay ? 'Playing...' : 'Replay'}</span>
              <span className="sc-tile-sub">{replayClips[0] ? `${replayClips[0].durationSec}s missed note` : 'No past clips'}</span>
            </div>
          </button>

          {/* Hands-Free VOX Mode Toggle */}
          <button
            className={`sc-action-tile sc-vox-tile ${voxEnabled ? 'sc-tile-active-olive' : ''}`}
            onClick={() => setVoxEnabled(prev => !prev)}
            title="Voice-Activated Transmission (Hands-free)"
          >
            <span className="sc-tile-icon">{voxEnabled ? '🎙️' : '🔇'}</span>
            <div className="sc-tile-info">
              <span className="sc-tile-title">Hands-Free</span>
              <span className="sc-tile-sub">{voxEnabled ? 'VOX Active' : 'Hold to talk'}</span>
            </div>
          </button>

          {/* Flip Camera (visible when camera is running) */}
          {isLocalVideoActive && (
            <button
              className="sc-action-tile sc-flip-tile"
              onClick={flipCamera}
              title="Flip between front and rear camera"
            >
              <span className="sc-tile-icon">🔄</span>
              <div className="sc-tile-info">
                <span className="sc-tile-title">Flip Camera</span>
                <span className="sc-tile-sub">{facingMode === 'user' ? 'Front Cam' : 'Rear Cam'}</span>
              </div>
            </button>
          )}
        </div>

        {/* VOX Level Bar (when enabled) */}
        {voxEnabled && (
          <div className="sc-vox-meter-container">
            <div className="sc-vox-meter-label">
              <span>VOX Sensitivity</span>
              <span>{voxLevel}%</span>
            </div>
            <div className="sc-vox-meter-track">
              <div
                className="sc-vox-meter-fill"
                style={{
                  width: `${voxLevel}%`,
                  backgroundColor: voxLevel > 15 ? COLORS.emerald : COLORS.terracotta,
                }}
              />
              <div className="sc-vox-meter-threshold" style={{ left: '15%' }} title="Trigger Threshold" />
            </div>
          </div>
        )}

        {/* Recent Transmissions History */}
        {replayClips.length > 1 && (
          <div className="sc-replay-history">
            <span className="sc-history-title">Recent Transmissions:</span>
            <div className="sc-history-list">
              {replayClips.map((clip, index) => (
                <button
                  key={clip.id}
                  className={`sc-history-chip ${isPlayingReplay === clip.id ? 'sc-chip-playing' : ''}`}
                  onClick={() => handleTogglePlayReplay(clip)}
                >
                  {isPlayingReplay === clip.id ? '⏹' : '▶'} #{index + 1} ({clip.durationSec}s at {clip.timeStr})
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Info footer */}
        <div className="sc-ptt-info">
          <div className="sc-info-chip">
            <span className="sc-info-dot" style={{ background: COLORS.terracotta }} />
            You: <strong>{userId}</strong>
          </div>
          <button
            id="leave-btn"
            className="sc-leave-btn"
            onClick={() => {
              void cleanup();
              setPhase('join');
              setConnState('disconnected');
              setPeers([]);
              setStatusMsg('');
              setPartnerTelemetry(null);
              setReplayClips([]);
              setIsLocalVideoActive(false);
              setIsRemoteVideoActive(false);
            }}
          >
            Leave Channel
          </button>
        </div>
      </main>
    </div>
  );
}
