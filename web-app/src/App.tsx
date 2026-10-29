import { useCallback, useEffect, useRef, useState } from 'react';
import { WS_BASE_URL, RTC_CONFIG, COLORS } from './constants';
import './App.css';

// ─── Types ───────────────────────────────────────────────────────────────────
type AppPhase = 'join' | 'connecting' | 'ready';
type ConnState = 'disconnected' | 'connecting' | 'connected';

// ─── Main App ────────────────────────────────────────────────────────────────
export default function App() {
  const [phase, setPhase] = useState<AppPhase>('join');
  const [roomId, setRoomId] = useState('');
  const [userId, setUserId] = useState('');
  const [connState, setConnState] = useState<ConnState>('disconnected');
  const [peers, setPeers] = useState<string[]>([]);
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [isReceiving, setIsReceiving] = useState(false);
  const [statusMsg, setStatusMsg] = useState('Waiting for partner...');
  const [micAllowed, setMicAllowed] = useState<boolean | null>(null);
  const [incomingPing, setIncomingPing] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const pingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);
  const politeRef = useRef(false); // polite peer = second to join
  const peersRef = useRef<string[]>([]);

  // ─── Cleanup ────────────────────────────────────────────────────────────
  const cleanup = useCallback(() => {
    wsRef.current?.close();
    pcRef.current?.close();
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    wsRef.current = null;
    pcRef.current = null;
    localStreamRef.current = null;
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  // ─── Join Room ──────────────────────────────────────────────────────────
  const joinRoom = async () => {
    const trimRoom = roomId.trim();
    const trimUser = userId.trim();
    if (!trimRoom || !trimUser) return;

    setPhase('connecting');
    setStatusMsg('Requesting microphone...');

    // 1. Get mic
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getAudioTracks().forEach(t => (t.enabled = false)); // muted until PTT
      localStreamRef.current = stream;
      setMicAllowed(true);
    } catch {
      setMicAllowed(false);
      setStatusMsg('❌ Microphone permission denied. Please allow mic access and try again.');
      setPhase('join');
      return;
    }

    // 2. Connect WebSocket
    setStatusMsg('Connecting to signaling server...');
    const ws = new WebSocket(`${WS_BASE_URL}/${trimRoom}/${trimUser}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatusMsg('Waiting for partner...');
      initPeerConnection(trimRoom, trimUser, ws);
      setPhase('ready');
    };

    ws.onerror = () => {
      setStatusMsg('❌ Cannot reach signaling server. Is the backend running?');
      setPhase('join');
      cleanup();
    };

    ws.onclose = () => {
      if (phase === 'ready') {
        setConnState('disconnected');
        setStatusMsg('🔌 Disconnected from server.');
      }
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      await handleSignal(msg, trimUser, trimRoom, ws);
    };
  };

  // ─── Peer Connection ─────────────────────────────────────────────────────
  const initPeerConnection = (room: string, uid: string, ws: WebSocket) => {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pcRef.current = pc;

    // Add local tracks
    localStreamRef.current?.getTracks().forEach(t => {
      pc.addTrack(t, localStreamRef.current!);
    });

    // Remote audio
    pc.ontrack = (e) => {
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = e.streams[0];
      }
      // Detect when remote audio is playing
      setIsReceiving(true);
      e.streams[0].getTracks()[0].onended = () => setIsReceiving(false);
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
      } else if (s === 'checking') {
        setConnState('connecting');
        setStatusMsg('🔄 Establishing P2P connection...');
      }
    };

    pc.onnegotiationneeded = async () => {
      if (peersRef.current.length === 0) return; // no partner yet
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
  const handleSignal = async (msg: Record<string, unknown>, uid: string, room: string, ws: WebSocket) => {
    const pc = pcRef.current;

    // We just joined and the server tells us who's already here
    if (msg.type === 'room_state') {
      const existingPeers = msg.peers as string[];
      setPeers(existingPeers);
      peersRef.current = existingPeers;
      politeRef.current = false; // We are the newcomer = impolite = we send the offer
      setStatusMsg(`🔄 Partner found! Establishing P2P...`);

      // Initiate WebRTC offer to the first existing peer
      if (existingPeers.length > 0 && pc) {
        try {
          makingOfferRef.current = true;
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          ws.send(JSON.stringify({ type: 'offer', target_id: existingPeers[0], offer: pc.localDescription }));
        } catch (e) {
          console.error('Offer error:', e);
        } finally {
          makingOfferRef.current = false;
        }
      }
    }

    // Someone new joined our room — we were here first
    if (msg.type === 'peer_joined') {
      const newPeer = msg.user_id as string;
      const updated = [...peersRef.current.filter(id => id !== newPeer), newPeer];
      setPeers(updated);
      peersRef.current = updated;
      politeRef.current = true; // We are the existing peer = polite = we wait for their offer
      setStatusMsg(`🔄 Partner found! Establishing P2P...`);
    }

    if (msg.type === 'peer_left') {
      setConnState('disconnected');
      setStatusMsg('⚠️ Partner left the room');
      setPeers(p => p.filter(id => id !== msg.user_id));
    }

    if (!pc) return;

    if (msg.type === 'offer') {
      const offerCollision = makingOfferRef.current || pc.signalingState !== 'stable';
      ignoreOfferRef.current = !politeRef.current && offerCollision;
      if (ignoreOfferRef.current) return;

      await pc.setRemoteDescription(new RTCSessionDescription(msg.offer as RTCSessionDescriptionInit));
      await pc.setLocalDescription();
      ws.send(JSON.stringify({ type: 'answer', target_id: msg.user_id ?? peers[0], answer: pc.localDescription }));
    }

    if (msg.type === 'answer') {
      if (pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription(new RTCSessionDescription(msg.answer as RTCSessionDescriptionInit));
    }

    if (msg.type === 'ice-candidate' && msg.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(msg.candidate as RTCIceCandidateInit));
      } catch (e) {
        if (!ignoreOfferRef.current) console.error('ICE error:', e);
      }
    }

    if (msg.type === 'ptt_start') {
      setIsReceiving(true);
      triggerIncomingPing();
      if (navigator.vibrate) navigator.vibrate([30, 50, 30]);
    }

    if (msg.type === 'ptt_end') {
      setIsReceiving(false);
    }
  };

  // ─── PTT Button ──────────────────────────────────────────────────────────
  const handlePTTStart = () => {
    if (connState !== 'connected') return;
    setIsTransmitting(true);
    localStreamRef.current?.getAudioTracks().forEach(t => (t.enabled = true));
    wsRef.current?.send(JSON.stringify({ type: 'ptt_start', target_id: peersRef.current[0] }));
    if (navigator.vibrate) navigator.vibrate(40);
  };

  const handlePTTEnd = () => {
    setIsTransmitting(false);
    localStreamRef.current?.getAudioTracks().forEach(t => (t.enabled = false));
    wsRef.current?.send(JSON.stringify({ type: 'ptt_end', target_id: peersRef.current[0] }));
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
            <p className="join-sub">Peer-to-peer · Zero cost · No accounts</p>
          </div>

          {micAllowed === false && (
            <div className="alert alert-danger">
              🎙 Microphone permission denied. Please allow access in your browser settings and refresh.
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Room ID</label>
            <input
              id="room-id-input"
              className="form-input"
              type="text"
              placeholder="e.g. yashwanth-priya"
              value={roomId}
              onChange={e => setRoomId(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && joinRoom()}
              disabled={phase === 'connecting'}
              autoCapitalize="none"
              autoCorrect="off"
            />
            <span className="form-hint">Both devices must enter the same Room ID</span>
          </div>

          <div className="form-group">
            <label className="form-label">Your Name</label>
            <input
              id="user-id-input"
              className="form-input"
              type="text"
              placeholder="e.g. android or windows"
              value={userId}
              onChange={e => setUserId(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && joinRoom()}
              disabled={phase === 'connecting'}
              autoCapitalize="none"
              autoCorrect="off"
            />
            <span className="form-hint">Unique name for this device in the room</span>
          </div>

          <button
            id="join-btn"
            className="join-btn"
            onClick={joinRoom}
            disabled={phase === 'connecting' || !roomId.trim() || !userId.trim()}
          >
            {phase === 'connecting' ? (
              <><span className="spinner" /> Connecting...</>
            ) : (
              '📡 Join Room'
            )}
          </button>

          <p className="join-footer">
            Works on Android Chrome &amp; Windows browsers. No app install needed.
          </p>
        </div>
      </div>
    );
  }

  // ─── Render: PTT Screen ──────────────────────────────────────────────────
  return (
    <div className="app-shell">
      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />

      {/* Header */}
      <header className="ptt-header">
        <div className="header-left">
          <span className="header-icon">📻</span>
          <div>
            <div className="header-title">Walkie-Talkie</div>
            <div className="header-room">Room: <strong>{roomId}</strong></div>
          </div>
        </div>
        <div className={`status-chip status-${connState}`}>
          <span className="status-dot" />
          {connState === 'connected' ? 'Connected' : connState === 'connecting' ? 'Connecting' : 'Offline'}
        </div>
      </header>

      {/* Main PTT area */}
      <main className="ptt-main">
        {/* Status message */}
        <div className="status-banner">
          <p className="status-text">{statusMsg}</p>
          {peers.length > 0 && (
            <p className="peer-text">Partner: <strong>{peers[0]}</strong></p>
          )}
        </div>

        {/* Receiving indicator */}
        <div className={`rx-indicator ${isReceiving ? 'rx-active' : ''}`}>
          <div className="rx-bars">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className={`rx-bar rx-bar-${i}`} />
            ))}
          </div>
          <span className="rx-label">{isReceiving ? 'RECEIVING' : 'STANDBY'}</span>
        </div>

        {/* PTT Button */}
        <div className="ptt-wrap">
          {/* Outer pulse rings */}
          <div className={`ptt-ring ptt-ring-3 ${isTransmitting ? 'ring-active' : ''}`} />
          <div className={`ptt-ring ptt-ring-2 ${isTransmitting ? 'ring-active' : ''}`} />
          <div className={`ptt-ring ptt-ring-1 ${isTransmitting ? 'ring-active' : ''}`} />

          <button
            id="ptt-button"
            className={`ptt-btn ${isTransmitting ? 'ptt-tx' : ''} ${connState !== 'connected' ? 'ptt-disabled' : ''} ${incomingPing ? 'ptt-incoming' : ''}`}
            onMouseDown={handlePTTStart}
            onMouseUp={handlePTTEnd}
            onMouseLeave={isTransmitting ? handlePTTEnd : undefined}
            onTouchStart={e => { e.preventDefault(); handlePTTStart(); }}
            onTouchEnd={e => { e.preventDefault(); handlePTTEnd(); }}
            disabled={connState !== 'connected'}
            aria-label="Push to talk"
          >
            <span className="ptt-icon">{isTransmitting ? '🎙' : '📡'}</span>
            <span className="ptt-label">
              {isTransmitting ? 'TRANSMITTING' : connState !== 'connected' ? 'OFFLINE' : 'HOLD TO TALK'}
            </span>
          </button>
        </div>

        {/* Info footer */}
        <div className="ptt-info">
          <div className="info-chip">
            <span className="info-dot" style={{ background: COLORS.primary }} />
            You: <strong>{userId}</strong>
          </div>
          <button
            id="leave-btn"
            className="leave-btn"
            onClick={() => { cleanup(); setPhase('join'); setConnState('disconnected'); setPeers([]); setStatusMsg(''); }}
          >
            Leave Room
          </button>
        </div>
      </main>
    </div>
  );
}