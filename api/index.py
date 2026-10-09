"""Vercel entry point: exposes the FastAPI app as a serverless function.
Static files (dashboard, SDK scripts, demo) are served from public/ by Vercel's CDN; only API calls reach this."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.main import app  # noqa: E402,F401
