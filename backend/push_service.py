"""
push_service.py — FCM + APNs wake-up push sender
Sends data-only high-priority push to wake the other device into the LiveKit room.
"""

import os
import json
import logging
import httpx
from typing import Optional

logger = logging.getLogger(__name__)

# In-memory device token registry (replaced by Redis in production)
# Key: user_id → Value: { "platform": "android"|"ios", "token": "..." }
_device_registry: dict[str, dict] = {}


def register_device(user_id: str, platform: str, token: str) -> None:
    """Store a device's push token."""
    _device_registry[user_id] = {"platform": platform, "token": token}
    logger.info(f"Registered device: {user_id} ({platform})")


def get_device(user_id: str) -> Optional[dict]:
    return _device_registry.get(user_id)


async def send_dropin_push(target_user_id: str, from_user_id: str, action: str = "drop_in") -> bool:
    """
    Send a wake-up push to the target user's device.

    Args:
        target_user_id: Who to wake up
        from_user_id: Who is initiating the drop-in
        action: 'drop_in' or 'hang_up'

    Returns:
        True if push was sent successfully
    """
    device = get_device(target_user_id)
    if not device:
        logger.warning(f"No device registered for {target_user_id}")
        return False

    platform = device["platform"]
    token = device["token"]

    if platform == "android":
        return await _send_fcm_push(token, from_user_id, action)
    elif platform == "ios":
        return await _send_apns_push(token, from_user_id, action)
    else:
        logger.error(f"Unknown platform: {platform}")
        return False


async def _send_fcm_push(fcm_token: str, from_user_id: str, action: str) -> bool:
    """
    Send a data-only high-priority FCM message to Android.
    IMPORTANT: No 'notification' key — data-only messages bypass Android's
    system notification tray and go directly to FirebaseMessagingService.
    """
    try:
        import firebase_admin
        from firebase_admin import messaging, credentials

        from config import FIREBASE_CREDENTIALS_PATH

        # Initialize Firebase app once
        if not firebase_admin._apps:
            if os.path.exists(FIREBASE_CREDENTIALS_PATH):
                cred = credentials.Certificate(FIREBASE_CREDENTIALS_PATH)
                firebase_admin.initialize_app(cred)
            else:
                logger.error(f"Firebase credentials not found at {FIREBASE_CREDENTIALS_PATH}")
                return False

        message = messaging.Message(
            data={
                "action": action,
                "from_user": from_user_id,
                "room": "walkie-talk-room",
            },
            token=fcm_token,
            android=messaging.AndroidConfig(
                priority="high",            # Wakes device from Doze immediately
                ttl=30,                     # 30 second TTL — stale drop-ins are worthless
            ),
        )

        response = messaging.send(message)
        logger.info(f"FCM sent: {response}")
        return True

    except Exception as e:
        logger.error(f"FCM send failed: {e}")
        return False


async def _send_apns_push(device_token: str, from_user_id: str, action: str) -> bool:
    """
    Send an APNs VoIP push to iOS (via HTTP/2 APNs API).
    For MVP/sideload via AltStore, we use a WebSocket fallback instead of APNs.
    This function is a placeholder — the iOS client maintains a persistent
    WebSocket connection that serves as the wake-up mechanism.
    """
    logger.info(f"APNs push requested for {device_token[:8]}... — using WebSocket fallback for sideload")
    # The actual wake-up for sideloaded iOS goes through WebSocket signaling
    # See main.py WebSocket handler — it pushes events directly to connected iOS clients
    return True
