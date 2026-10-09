"""Vercel entry point: exposes the FastAPI app as a serverless function.
Static files (dashboard, SDK scripts, demo) are served from public/ by Vercel's CDN; only API calls reach this."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from backend.main import app  # noqa: F401
except Exception:  # a startup crash would otherwise be an opaque FUNCTION_INVOCATION_FAILED
    import traceback

    from fastapi import FastAPI
    from fastapi.responses import PlainTextResponse

    _trace = traceback.format_exc()
    print(_trace, file=sys.stderr)          # always visible in Vercel's runtime logs
    app = FastAPI()

    @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
    def _startup_failed(path: str):
        # the traceback is only shown publicly when you opt in (it can reveal file paths)
        body = _trace if os.getenv("DEBUG_STARTUP") == "1" else \
            "The server failed to start. Open Vercel > Logs for details, or set DEBUG_STARTUP=1 to show the error here."
        return PlainTextResponse(body, status_code=500)
