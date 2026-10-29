"""
main.py — Pure WebRTC Signaling Relay (FastAPI + WebSockets)
No LiveKit, No Firebase, No Redis — Zero external dependencies.
Acts as a dumb relay: receives messages from one peer and forwards to the target.
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import json
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

app = FastAPI(title="Walkie-Talkie Signaling Server", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Room-based connections: { room_id: { user_id: WebSocket } }
rooms: dict[str, dict[str, WebSocket]] = {}


@app.get("/health")
async def health():
    """Health check endpoint."""
    connected = sum(len(users) for users in rooms.values())
    return {"status": "ok", "rooms": len(rooms), "connected_peers": connected}


@app.websocket("/ws/{room_id}/{user_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str, user_id: str):
    await websocket.accept()
    async def connect(self, websocket: WebSocket, room_id: str, client_id: str):
        await websocket.accept()
        
        if room_id not in self.rooms:
            self.rooms[room_id] = {}

        # 1. Send the existing room state to the NEW joiner
        existing_peers = list(self.rooms[room_id].keys())
        await websocket.send_json({
            "type": "room_state",
            "peers": existing_peers
        })

        # 2. Add the new client to the room
        self.rooms[room_id][client_id] = websocket

        # 3. Notify existing peers that a new peer joined
        for peer_id, connection in self.rooms[room_id].items():
            if peer_id != client_id:
                await connection.send_json({
                    "type": "peer_joined",
                    "peerId": client_id
                })

    # Register in room
    if room_id not in rooms:
        rooms[room_id] = {}
    rooms[room_id][user_id] = websocket
    log.info(f"[{room_id}] '{user_id}' joined. Peers in room: {list(rooms[room_id].keys())}")

    # Notify all other peers in the room that a new user joined
    await _broadcast_to_room(room_id, user_id, {
        "type": "peer_joined",
        "user_id": user_id,
        "peers": [uid for uid in rooms[room_id] if uid != user_id],
    })

    try:
        while True:
            raw = await websocket.receive_text()
            message = json.loads(raw)
            target_id = message.get("target_id")

            if target_id:
                # Unicast: relay directly to the specified peer
                target_ws = rooms.get(room_id, {}).get(target_id)
                if target_ws:
                    await target_ws.send_text(raw)
                else:
                    log.warning(f"[{room_id}] Target '{target_id}' not found.")
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": f"Peer '{target_id}' is not connected.",
                    }))
            else:
                # Broadcast: relay to everyone else in the room
                await _broadcast_to_room(room_id, user_id, message)

    except WebSocketDisconnect:
        _cleanup(room_id, user_id)
        log.info(f"[{room_id}] '{user_id}' disconnected.")
        # Notify remaining peers
        await _broadcast_to_room(room_id, None, {
            "type": "peer_left",
            "user_id": user_id,
        })

    except Exception as e:
        log.error(f"[{room_id}] Error for '{user_id}': {e}")
        _cleanup(room_id, user_id)


async def _broadcast_to_room(room_id: str, exclude_user_id: str | None, message: dict):
    """Send a message to all peers in a room except the sender."""
    peers = rooms.get(room_id, {})
    dead = []
    for uid, ws in peers.items():
        if uid == exclude_user_id:
            continue
        try:
            await ws.send_text(json.dumps(message))
        except Exception:
            dead.append(uid)
    for uid in dead:
        _cleanup(room_id, uid)


def _cleanup(room_id: str, user_id: str):
    """Remove a user from its room and prune empty rooms."""
    if room_id in rooms:
        rooms[room_id].pop(user_id, None)
        if not rooms[room_id]:
            del rooms[room_id]
            log.info(f"[{room_id}] Room is now empty and removed.")