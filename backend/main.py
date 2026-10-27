"""
main.py — Walkie-Talk Signaling Server
Flask (HTTP) + websockets (WS) — no pydantic, works on Python 3.14

Run: python main.py
"""

import asyncio
import json
import logging
import os
import threading
from typing import Dict

import websockets
import websockets.asyncio.server
from flask import Flask, jsonify, request
from flask_cors import CORS

from config import IOS_USER_ID, ANDROID_USER_ID, LIVEKIT_ROOM_NAME, LIVEKIT_URL
from livekit_token import generate_token
from push_service import register_device, send_dropin_push

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Flask HTTP Server
# ---------------------------------------------------------------------------

flask_app = Flask(__name__)
CORS(flask_app)


@flask_app.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "room": LIVEKIT_ROOM_NAME,
        "livekit_url": LIVEKIT_URL,
        "online_users": list(ws_manager.active.keys()),
    })


@flask_app.post("/token")
def get_token():
    body = request.get_json(force=True) or {}
    user_id = body.get("user_id", "")
    room = body.get("room", LIVEKIT_ROOM_NAME)

    if user_id not in [IOS_USER_ID, ANDROID_USER_ID]:
        return jsonify({"error": f"Unknown user_id: {user_id}"}), 403

    token = generate_token(identity=user_id, room=room)
    logger.info(f"Token issued for {user_id}")
    return jsonify({"token": token, "url": LIVEKIT_URL, "room": room, "identity": user_id})


@flask_app.post("/register")
def register():
    body = request.get_json(force=True) or {}
    user_id = body.get("user_id", "")
    platform = body.get("platform", "")
    push_token = body.get("push_token", "")
    register_device(user_id=user_id, platform=platform, push_token=push_token)
    return jsonify({"status": "registered", "user_id": user_id})


@flask_app.post("/drop-in")
def drop_in():
    body = request.get_json(force=True) or {}
    from_user_id = body.get("from_user_id", "")
    action = body.get("action", "drop_in")

    if from_user_id == IOS_USER_ID:
        target_user_id = ANDROID_USER_ID
    elif from_user_id == ANDROID_USER_ID:
        target_user_id = IOS_USER_ID
    else:
        return jsonify({"error": "Unknown from_user_id"}), 403

    payload = {"type": action, "from": from_user_id, "room": LIVEKIT_ROOM_NAME}

    # Try WS delivery (non-blocking via the event loop thread)
    ws_delivered = asyncio.run_coroutine_threadsafe(
        ws_manager.send(target_user_id, payload),
        ws_loop
    ).result(timeout=2)

    push_sent = False
    if not ws_delivered:
        logger.info(f"Target {target_user_id} not on WS, sending push...")
        push_sent = asyncio.run_coroutine_threadsafe(
            send_dropin_push(target_user_id, from_user_id, action),
            ws_loop
        ).result(timeout=5)

    return jsonify({
        "status": "delivered" if (ws_delivered or push_sent) else "pending",
        "ws_delivered": ws_delivered,
        "push_sent": push_sent,
        "target": target_user_id,
    })


# ---------------------------------------------------------------------------
# WebSocket Manager
# ---------------------------------------------------------------------------

class ConnectionManager:
    def __init__(self):
        self.active: Dict[str, websockets.asyncio.server.ServerConnection] = {}

    async def connect(self, user_id: str, ws):
        self.active[user_id] = ws
        logger.info(f"WS connected: {user_id}. Online: {list(self.active.keys())}")

    def disconnect(self, user_id: str):
        self.active.pop(user_id, None)
        logger.info(f"WS disconnected: {user_id}. Online: {list(self.active.keys())}")

    async def send(self, user_id: str, payload: dict) -> bool:
        ws = self.active.get(user_id)
        if ws:
            try:
                await ws.send(json.dumps(payload))
                return True
            except Exception as e:
                logger.error(f"WS send to {user_id} failed: {e}")
                self.active.pop(user_id, None)
        return False


ws_manager = ConnectionManager()
ws_loop: asyncio.AbstractEventLoop = None  # Set when WS server thread starts


async def handle_ws(ws):
    """Handle a new WebSocket connection."""
    # Extract user_id from path: /ws/ios-user or /ws/android-user
    path = ws.request.path if hasattr(ws, "request") else getattr(ws, "path", "/")
    user_id = path.strip("/").split("/")[-1]

    if user_id not in [IOS_USER_ID, ANDROID_USER_ID]:
        await ws.close(4003, "Unknown user")
        return

    await ws_manager.connect(user_id, ws)
    other = ANDROID_USER_ID if user_id == IOS_USER_ID else IOS_USER_ID
    await ws_manager.send(other, {"type": "partner_online", "user": user_id})

    try:
        async for raw in ws:
            try:
                data = json.loads(raw)
                event_type = data.get("type", "")

                if event_type == "heartbeat":
                    await ws.send(json.dumps({"type": "heartbeat_ack"}))
                elif event_type in ("drop_in", "hang_up", "mic_mute", "mic_unmute", "status"):
                    await ws_manager.send(other, {**data, "from": user_id})
                else:
                    logger.warning(f"Unknown event from {user_id}: {event_type}")
            except json.JSONDecodeError:
                logger.warning(f"Invalid JSON from {user_id}")
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        ws_manager.disconnect(user_id)
        await ws_manager.send(other, {"type": "partner_offline", "user": user_id})


def run_ws_server():
    """Run the async WebSocket server in its own thread with its own event loop."""
    global ws_loop
    ws_loop = asyncio.new_event_loop()
    asyncio.set_event_loop(ws_loop)

    async def _serve():
        async with websockets.asyncio.server.serve(handle_ws, "0.0.0.0", 8001):
            logger.info("🔌 WebSocket server running on ws://0.0.0.0:8001")
            await asyncio.Future()  # run forever

    ws_loop.run_until_complete(_serve())


# ---------------------------------------------------------------------------
# Entry Point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logger.info("🎙️  Walkie-Talk server starting...")
    logger.info(f"   LiveKit: {LIVEKIT_URL}")
    logger.info(f"   Room:    {LIVEKIT_ROOM_NAME}")

    # Start WS server in background thread
    ws_thread = threading.Thread(target=run_ws_server, daemon=True)
    ws_thread.start()

    # Start Flask HTTP server (blocking)
    flask_app.run(host="0.0.0.0", port=8000, debug=False, use_reloader=False)
