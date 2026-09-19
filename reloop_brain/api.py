from __future__ import annotations

import base64
import binascii
import io
import os
from pathlib import Path

from fastapi import APIRouter, FastAPI, HTTPException
from PIL import Image, UnidentifiedImageError
from pydantic import Field, model_validator

from contracts.schema import Capture, Condition, Contract, Goal, Item, Plan, Source
from reloop_brain.identify import (
    AnthropicVision,
    VisionProvider,
    items_from_observations,
    merge_scan_items,
)
from reloop_brain.planner import build_plan
from reloop_brain.pricing import PriceBook
from reloop_brain.service import ListingDraft, PricedItem, listing_draft, price_items

MAX_IMAGE_BYTES = 5 * 1024 * 1024


class IdentifyRequest(Contract):
    capture: Capture
    imageBase64: str = Field(max_length=7_000_000, min_length=1)
    existingItems: list[Item] = Field(default_factory=list, max_length=200)


class IdentifyResponse(Contract):
    items: list[Item]
    pricedItems: list[PricedItem]
    dropped: bool = False
    warnings: list[str] = Field(default_factory=list)


class PlanRequest(Contract):
    items: list[Item] = Field(min_length=1, max_length=200)
    goal: Goal
    keepItemIds: list[str] = Field(default_factory=list)


class ConfirmRequest(Contract):
    item: Item
    label: str = Field(min_length=1, max_length=200)
    category: str
    condition: Condition
    confirmed: bool

    @model_validator(mode="after")
    def require_confirmation(self):
        if not self.confirmed:
            raise ValueError("Explicit owner confirmation is required")
        return self


def decode_image(encoded: str) -> tuple[bytes, str]:
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(
            "imageBase64 must contain raw base64 image bytes, without a data URL prefix"
        ) from exc
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("Image must be between 1 byte and 5 MiB")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            media_type = Image.MIME.get(image.format)
            if media_type not in ("image/jpeg", "image/png", "image/webp"):
                raise ValueError("Use JPEG, PNG, or WebP; convert iPhone HEIC before upload")
            if image.width * image.height > 20_000_000:
                raise ValueError("Resize the image to at most 20 megapixels")
            image.verify()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("Invalid or oversized image") from exc
    return raw, media_type


def configured_book() -> PriceBook:
    path = Path(
        os.getenv(
            "RELOOP_PRICE_BOOK", str(Path(__file__).resolve().parents[1] / "data/price_book.csv")
        )
    )
    return PriceBook.load(path, allow_demo=os.getenv("RELOOP_ALLOW_DEMO_PRICES") == "1")


def create_router(book: PriceBook | None = None, vision: VisionProvider | None = None) -> APIRouter:
    router = APIRouter(tags=["Lane B"])

    def get_book() -> PriceBook:
        try:
            return book or configured_book()
        except (OSError, ValueError) as exc:
            raise HTTPException(503, str(exc)) from exc

    def get_vision() -> VisionProvider:
        if vision is not None:
            return vision
        key, model = os.getenv("ANTHROPIC_API_KEY"), os.getenv("RELOOP_VISION_MODEL")
        if not key or not model:
            raise HTTPException(
                503, "Set ANTHROPIC_API_KEY and RELOOP_VISION_MODEL for live identification"
            )
        return AnthropicVision(model=model, api_key=key)

    @router.post("/identify", response_model=IdentifyResponse)
    async def identify(request: IdentifyRequest):
        price_book = get_book()
        try:
            image, media_type = decode_image(request.imageBase64)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        provider = get_vision()
        try:
            result = await provider.identify(
                image,
                media_type,
                request.capture,
                {key: row.label for key, row in price_book.entries.items()},
            )
        except Exception as exc:
            # Never send provider errors, request bodies, keys, or image payloads to clients.
            raise HTTPException(
                502, "Vision provider failed; retry or review the item manually"
            ) from exc
        finally:
            if vision is None:
                await provider.client.close()
        if request.capture.source == Source.DOG and result.containsPeople:
            return IdentifyResponse(
                items=request.existingItems,
                pricedItems=price_items(request.existingItems, price_book),
                dropped=True,
                warnings=[
                    (
                        "Dog frame flagged as containing people; "
                        "do not publish or retain this capture."
                    )
                ],
            )
        candidates = items_from_observations(result, request.capture, price_book)
        items = merge_scan_items(request.existingItems, candidates)
        warnings = ["Condition is a visual estimate, not a functional test."]
        if any(entry.is_demo for entry in price_book.entries.values()):
            warnings.append("Price book contains unresearched demo estimates.")
        return IdentifyResponse(
            items=items, pricedItems=price_items(items, price_book), warnings=warnings
        )

    @router.post("/items/confirm", response_model=PricedItem)
    def confirm(request: ConfirmRequest):
        price_book = get_book()
        try:
            price_book.get(request.category)
            item = request.item.model_copy(
                update={
                    "label": request.label,
                    "category": request.category,
                    "condition": request.condition,
                    "confirmedByUser": True,
                    "question": None,
                }
            )
            return price_items([item], price_book)[0]
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @router.post("/plan", response_model=Plan)
    def plan(request: PlanRequest):
        price_book = get_book()
        try:
            return build_plan(
                request.items, request.goal, price_book, keep_ids=set(request.keepItemIds)
            )
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @router.post("/listing-draft", response_model=ListingDraft)
    def draft(item: Item):
        price_book = get_book()
        try:
            return listing_draft(item, price_book)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    return router


def create_app(book: PriceBook | None = None, vision: VisionProvider | None = None) -> FastAPI:
    app = FastAPI(title="ReLoop Lane B", version="0.1.0")
    app.include_router(create_router(book, vision))

    @app.get("/health")
    def health():
        return {"status": "ok", "service": "reloop-brain"}

    return app


app = create_app()
