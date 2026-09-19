from __future__ import annotations

import base64
import re
from difflib import SequenceMatcher
from importlib.resources import files
from typing import Protocol
from uuid import NAMESPACE_URL, uuid5

from pydantic import Field

from contracts.schema import Capture, Condition, Contract, Item, Question, Source
from reloop_brain.catalog import recognition_categories
from reloop_brain.pricing import PriceBook


class Observation(Contract):
    label: str = Field(min_length=1, max_length=200)
    category: str
    condition: Condition
    confidence: float = Field(ge=0, le=1, allow_inf_nan=False)
    variantAmbiguous: bool = False
    question: Question | None = None


class VisionResult(Contract):
    containsPeople: bool
    items: list[Observation] = Field(max_length=30)


class VisionProvider(Protocol):
    async def identify(
        self, image: bytes, media_type: str, capture: Capture, categories: dict[str, str]
    ) -> VisionResult: ...


class AnthropicVision:
    def __init__(self, *, model: str, api_key: str):
        from anthropic import AsyncAnthropic

        self.client = AsyncAnthropic(api_key=api_key, timeout=45, max_retries=1)
        self.model = model

    async def aclose(self):
        await self.client.close()

    async def identify(
        self, image: bytes, media_type: str, capture: Capture, categories: dict[str, str]
    ) -> VisionResult:
        schema = VisionResult.model_json_schema()
        schema["$defs"]["Observation"]["properties"]["category"] = {
            "type": "string",
            "enum": [*categories, "other.unknown"],
        }
        prompt = files("reloop_brain").joinpath("prompts/identify.txt").read_text()
        response = await self.client.messages.create(
            model=self.model,
            max_tokens=4096,
            system=prompt,
            tools=[
                {
                    "name": "record_items",
                    "description": "Record visible belongings only",
                    "input_schema": schema,
                }
            ],
            tool_choice={"type": "tool", "name": "record_items"},
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": base64.b64encode(image).decode(),
                            },
                        },
                        {
                            "type": "text",
                            "text": f"Source: {capture.source.value}\nCategories: {categories}",
                        },
                    ],
                }
            ],
        )
        if response.stop_reason == "max_tokens":
            raise ValueError("Vision response was truncated; retry with fewer objects in frame")
        blocks = [
            block
            for block in response.content
            if block.type == "tool_use" and block.name == "record_items"
        ]
        if len(blocks) != 1:
            raise ValueError("Vision returned no single structured item result")
        return VisionResult.model_validate(blocks[0].input)


def items_from_observations(result: VisionResult, capture: Capture, book: PriceBook) -> list[Item]:
    if capture.source == Source.DOG and result.containsPeople:
        return []
    items = []
    for index, observation in enumerate(result.items):
        category = (
            observation.category
            if observation.category in recognition_categories(book)
            else "other.unknown"
        )
        # Visual identity confidence is independent of whether we can price it.
        confidence = observation.confidence
        question = observation.question
        if category.startswith("accessories.rayban_"):
            question = Question(
                text="Which case is it? For a charging case, also confirm it charges correctly.",
                options=["Meta charging case", "Regular glasses case", "Not sure"],
            )
        if question is None and (
            confidence < 0.75
            or observation.variantAmbiguous
            or category in ("other.unknown", "phone.generic")
        ):
            question = Question(
                text=f"Can you confirm what this is: {observation.label}?",
                options=["Confirm or correct details", "Not sure"],
            )
        items.append(
            Item(
                id="it_" + uuid5(NAMESPACE_URL, f"reloop:{capture.id}:{index}").hex[:16],
                captureIds=[capture.id],
                label=observation.label,
                category=category,
                condition=observation.condition,
                confidence=confidence,
                foundBy=capture.source,
                question=question,
            )
        )
    return items


def normalized(label: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", label.lower()).strip()


def merge_scan_items(existing: list[Item], incoming: list[Item]) -> list[Item]:
    """Caller supplies ONE scan/spot scope. Never merge two objects in one photo.

    Label matching is a heuristic, not object tracking. A caller should send only
    the same spot's candidates; identical objects at different spots stay separate.
    """
    merged = [item.model_copy(deep=True) for item in existing]
    used = set()
    processed_captures = {capture_id for item in existing for capture_id in item.captureIds}
    for candidate in incoming:
        # The caller persists the complete result for a capture atomically. A
        # replay of an already-merged frame must not create a new duplicate ID.
        if set(candidate.captureIds).issubset(processed_captures):
            continue
        # Repeat capture uploads keep the prior owner's corrections.
        same_id = next((i for i, item in enumerate(merged) if item.id == candidate.id), None)
        if same_id is not None:
            used.add(same_id)
            continue
        match = next(
            (
                i
                for i, item in enumerate(existing)
                if i not in used
                and item.category == candidate.category
                and item.category != "other.unknown"
                and not set(item.captureIds).intersection(candidate.captureIds)
                and SequenceMatcher(
                    None, normalized(item.label), normalized(candidate.label)
                ).ratio()
                >= 0.92
            ),
            None,
        )
        if match is None:
            merged.append(candidate.model_copy(deep=True))
        else:
            used.add(match)
            previous = merged[match]
            capture_ids = list(dict.fromkeys(previous.captureIds + candidate.captureIds))
            if not previous.confirmedByUser and candidate.confidence > previous.confidence:
                merged[match] = candidate.model_copy(
                    update={
                        "id": previous.id,
                        "foundBy": previous.foundBy,
                        "captureIds": capture_ids,
                    }
                )
            else:
                previous.captureIds = capture_ids
    return merged
