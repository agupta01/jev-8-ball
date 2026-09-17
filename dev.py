"""Local game server. Test Turnstile keys never enter the public Modal API or site artifact."""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import modal
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from main import AskRequest, AskResponse


TEST_SITE_KEY = "1x00000000000000000000AA"
TEST_SECRET_KEY = "1x0000000000000000000000000000000AA"
LOCAL_HOSTS = {"localhost:4173", "127.0.0.1:4173"}
SITE = Path(__file__).parent / "site"
logger = logging.getLogger("jev.development")


def create_dev_api() -> FastAPI:
    @asynccontextmanager
    async def lifespan(api: FastAPI):
        worker = modal.Function.from_name(
            "jev-8-ball", "development_question", environment_name="jev-8-ball-prod"
        )
        await worker.hydrate.aio()
        api.state.worker = worker
        async with httpx.AsyncClient(timeout=15.0) as client:
            api.state.client = client
            yield

    api = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @api.middleware("http")
    async def local_boundary(request: Request, call_next):
        hosts = request.headers.getlist("host")
        if len(hosts) != 1 or hosts[0] not in LOCAL_HOSTS:
            return JSONResponse({"detail": "Use localhost:4173 or 127.0.0.1:4173."}, status_code=400)
        if request.method == "POST" and request.headers.getlist("origin") != [f"http://{hosts[0]}"]:
            return JSONResponse({"detail": "Only this local game may submit questions."}, status_code=403)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @api.get("/config.js")
    async def config():
        return Response(
            f"export const API_BASE = '/api';\nexport const TURNSTILE_SITE_KEY = '{TEST_SITE_KEY}';\n",
            media_type="text/javascript",
        )

    @api.get("/api/health")
    async def health():
        return {"status": "ok"}

    @api.post("/api/ask", response_model=AskResponse)
    async def ask(body: AskRequest, request: Request):
        try:
            verification = await request.app.state.client.post(
                "https://challenges.cloudflare.com/turnstile/v0/siteverify",
                data={"secret": TEST_SECRET_KEY, "response": body.turnstile_token},
            )
            verification.raise_for_status()
            result = verification.json()
        except (httpx.HTTPError, ValueError):
            raise HTTPException(502, "Could not reach Turnstile's test verification service.") from None
        if not isinstance(result, dict) or result.get("success") is not True:
            raise HTTPException(403, "The development challenge failed. Please try again.")
        try:
            # This is authenticated Modal RPC, not a public HTTP inference endpoint.
            return await request.app.state.worker.remote.aio(body.question)
        except Exception:
            logger.exception("Authenticated development inference failed")
            raise HTTPException(502, "Development inference failed. Check the local server terminal.") from None

    api.mount("/", StaticFiles(directory=SITE, html=True), name="game")
    return api


if __name__ == "__main__":
    uvicorn.run(create_dev_api(), host="127.0.0.1", port=4173)
