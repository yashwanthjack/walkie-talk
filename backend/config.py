"""
config.py — Minimal configuration for the pure WebRTC signaling server.
No LiveKit, Firebase, or Redis. Just the basics.
"""
import os
from dotenv import load_dotenv

load_dotenv()

# Backend host/port (used for reference; actual binding is via uvicorn args)
BACKEND_HOST = os.getenv("BACKEND_HOST", "0.0.0.0")
BACKEND_PORT = int(os.getenv("BACKEND_PORT", "8000"))

# CORS — set to your deployed frontend URL in production
# e.g. ALLOWED_ORIGINS=https://my-walkie-talkie.vercel.app
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*").split(",")
