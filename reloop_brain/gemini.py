"""Gemini Developer API adapter; credentials stay in the request header."""

from __future__ import annotations

import base64
import json
import re
from importlib.resources import files

import httpx

from contracts.schema import Capture
from reloop_brain.identify import VisionResult


class GeminiVision:
    def __init__(self, *, model: str, api_key: str):
        if not re.fullmatch(r"[a-zA-Z0-9._-]+", model):
            raise ValueError("Use a Gemini model ID, without a URL or models/ prefix")
        self.model = model
        self.client = httpx.AsyncClient(
            base_url="https://generativelanguage.googleapis.com/v1beta/",
            headers={"x-goog-api-key": api_key},
            timeout=60,
        )

    async def aclose(self):
        await self.client.aclose()

    async def identify(
        self, image: bytes, media_type: str, capture: Capture, categories: dict[str, str]
    ) -> VisionResult:
        schema = VisionResult.model_json_schema()
        schema["$defs"]["Observation"]["properties"]["category"] = {
            "type": "string",
            "enum": [*categories, "other.unknown"],
        }

        response = await self.client.post(
            f"models/{self.model}:generateContent",
            json={
                "systemInstruction": {
                    "parts": [
                        {"text": files("reloop_brain").joinpath("prompts/identify.txt").read_text()}
                    ]
                },
                "contents": [
                    {
                        "role": "user",
                        "parts": [
                            {
                                "inlineData": {
                                    "mimeType": media_type,
                                    "data": base64.b64encode(image).decode(),
                                }
                            },
                            {
                                "text": f"Source: {capture.source.value}\nCategories: {categories}\n"
                                "Return only JSON matching this schema, without markdown:\n"
                                + json.dumps(schema)
                            },
                        ],
                    }
                ],
                "generationConfig": {
                    "responseMimeType": "application/json",
                    "maxOutputTokens": 8192,
                },
            },
        )
        response.raise_for_status()
        candidates = response.json().get("candidates", [])
        if len(candidates) != 1 or candidates[0].get("finishReason") != "STOP":
            raise ValueError("Gemini returned no complete result; retry or review manually")
        text = "".join(
            part.get("text", "")
            for part in candidates[0].get("content", {}).get("parts", [])
            if not part.get("thought", False)
        )
        return VisionResult.model_validate_json(text)
