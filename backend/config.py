import os
from dotenv import load_dotenv

load_dotenv()

# LiveKit
LIVEKIT_URL = os.getenv("LIVEKIT_URL", "wss://your-project.livekit.cloud")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "")
LIVEKIT_ROOM_NAME = os.getenv("LIVEKIT_ROOM_NAME", "walkie-talk-room")

# User identities
IOS_USER_ID = os.getenv("IOS_USER_ID", "ios-user")
ANDROID_USER_ID = os.getenv("ANDROID_USER_ID", "android-user")

# Firebase
FIREBASE_CREDENTIALS_PATH = os.getenv("FIREBASE_CREDENTIALS_PATH", "./firebase-credentials.json")

# Redis
USE_REDIS = os.getenv("USE_REDIS", "false").lower() == "true"
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")

# Backend
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8000")
