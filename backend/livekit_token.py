"""
livekit_token.py — LiveKit JWT generation (livekit-api >= 1.0)
"""

from livekit.api import AccessToken, VideoGrants
from config import LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_ROOM_NAME, LIVEKIT_URL


def generate_token(identity: str, room: str = LIVEKIT_ROOM_NAME, ttl_seconds: int = 86400) -> str:
    """Generate a LiveKit JWT for a participant."""
    at = AccessToken(api_key=LIVEKIT_API_KEY, api_secret=LIVEKIT_API_SECRET)
    at.identity = identity
    at.name = identity
    at.ttl = ttl_seconds
    at.video_grants = VideoGrants(
        room_join=True,
        room=room,
        can_publish=True,
        can_subscribe=True,
        can_publish_data=True,
    )
    return at.to_jwt()
