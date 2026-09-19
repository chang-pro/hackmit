import asyncio
import base64
import json
from datetime import UTC, datetime

import httpx
import pytest
from fastapi.testclient import TestClient

from contracts.schema import Capture, Source
from reloop_brain.api import create_app
from reloop_brain.gemini import GeminiVision
from reloop_brain.pricing import PriceBook
from tests.test_brain import BOOK_PATH, image_base64


@pytest.mark.parametrize("finish", ["STOP", "MAX_TOKENS", "SAFETY", "missing", "invalid_json"])
def test_gemini_wire_contract(finish):
    async def run():
        provider = GeminiVision(model="test-model", api_key="test-placeholder")
        await provider.aclose()

        def respond(request):
            assert request.url.host == "generativelanguage.googleapis.com"
            assert not request.url.query
            assert request.headers["x-goog-api-key"] == "test-placeholder"
            data = json.loads(request.content)
            assert (
                base64.b64decode(data["contents"][0]["parts"][0]["inlineData"]["data"]) == b"image"
            )
            assert data["generationConfig"]["responseMimeType"] == "application/json"
            schema = json.loads(
                data["contents"][0]["parts"][1]["text"].split("without markdown:\n")[1]
            )
            assert schema["$defs"]["Observation"]["properties"]["category"]["enum"] == [
                "console.ps4_slim",
                "other.unknown",
            ]
            content = json.dumps({"containsPeople": False, "items": []})
            if finish == "invalid_json":
                content = "invalid"
            payload = {
                "candidates": [
                    {
                        "finishReason": "STOP" if finish == "invalid_json" else finish,
                        "content": {"parts": [{"text": content}]},
                    }
                ]
            }
            if finish == "missing":
                payload = {"promptFeedback": {"blockReason": "SAFETY"}}
            return httpx.Response(200, json=payload)

        provider.client = httpx.AsyncClient(
            base_url="https://generativelanguage.googleapis.com/v1beta/",
            headers={"x-goog-api-key": "test-placeholder"},
            transport=httpx.MockTransport(respond),
        )
        capture = Capture(
            id="cap_test", ts=datetime.now(UTC), source=Source.PHONE, uri="blob://test"
        )
        try:
            if finish == "STOP":
                result = await provider.identify(
                    b"image", "image/png", capture, {"console.ps4_slim": "PS4"}
                )
                assert result.items == []
            else:
                with pytest.raises(ValueError):
                    await provider.identify(
                        b"image", "image/png", capture, {"console.ps4_slim": "PS4"}
                    )
        finally:
            await provider.aclose()

    asyncio.run(run())


def test_gemini_config_and_error_redaction(monkeypatch):
    monkeypatch.setenv("RELOOP_VISION_PROVIDER", "gemini")
    monkeypatch.setenv("RELOOP_VISION_MODEL", "test-model")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    book = PriceBook.load(BOOK_PATH, allow_demo=True)
    payload = {
        "capture": {
            "id": "test",
            "ts": "2026-09-19T12:00:00Z",
            "source": "PHONE",
            "uri": "blob://test",
        },
        "imageBase64": image_base64(),
    }
    client = TestClient(create_app(book))
    missing = client.post("/identify", json=payload)
    assert missing.status_code == 503 and "GEMINI_API_KEY" in missing.text

    async def fail(self, *args, **kwargs):
        raise ValueError("private provider response")

    monkeypatch.setenv("GEMINI_API_KEY", "test-placeholder")
    monkeypatch.setattr(GeminiVision, "identify", fail)
    error = client.post("/identify", json=payload)
    assert error.status_code == 502
    assert "private" not in error.text and "test-placeholder" not in error.text


def test_model_is_not_an_arbitrary_url():
    with pytest.raises(ValueError):
        GeminiVision(model="https://example.com", api_key="test-placeholder")
