import base64
import io
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError

from contracts.schema import Action, Capture, Condition, Goal, Mode, Question, Source
from reloop_brain.api import create_app, decode_image
from reloop_brain.demo import demo_items
from reloop_brain.identify import (
    AnthropicVision,
    Observation,
    VisionResult,
    items_from_observations,
    merge_scan_items,
)
from reloop_brain.planner import build_plan
from reloop_brain.pricing import PriceBook, price_item

NOW = datetime(2026, 9, 19, 12, tzinfo=UTC)
BOOK_PATH = Path(__file__).resolve().parents[1] / "data/price_book.csv"


@pytest.fixture
def book():
    return PriceBook.load(BOOK_PATH, allow_demo=True)


@pytest.fixture
def capture():
    return Capture(id="cap_test", ts=NOW, source=Source.PHONE, uri="blob://test.jpg")


def image_base64():
    stream = io.BytesIO()
    Image.new("RGB", (16, 16), "white").save(stream, format="PNG")
    return base64.b64encode(stream.getvalue()).decode()


def observation(**overrides):
    return Observation(
        **dict(
            {
                "label": "Sony PS4 Slim",
                "category": "console.ps4_slim",
                "condition": "GOOD",
                "confidence": 0.95,
            },
            **overrides,
        )
    )


def test_fixture_prices_require_opt_in():
    with pytest.raises(ValueError, match="Fixture prices"):
        PriceBook.load(BOOK_PATH)


@pytest.mark.parametrize(
    "condition,normal",
    [
        (Condition.LIKE_NEW, 205),
        (Condition.GOOD, 185),
        (Condition.FAIR, 150),
        (Condition.POOR, 100),
        (Condition.BROKEN, 30),
    ],
)
def test_price_condition_adjustments(book, condition, normal):
    item = demo_items()[0].model_copy(update={"condition": condition})
    band = price_item(item, book)
    assert band.normalUsd == normal
    assert band.quickUsd <= band.normalUsd <= band.maxUsd
    assert "NOT MARKET RESEARCH" in band.basis


def test_ps4_band_matches_plan(book):
    band = price_item(demo_items()[0], book)
    assert (band.quickUsd, band.normalUsd, band.maxUsd) == (160, 185, 210)


@pytest.mark.parametrize("mode", list(Mode))
def test_all_modes_are_unapproved_and_json_has_no_floor(book, mode):
    goal = Goal(
        mode=mode,
        targetUsd=300,
        **({"upgradeTo": "console.ps5", "budgetUsd": 150} if mode == Mode.UPGRADE else {}),
    )
    plan = build_plan(demo_items(), goal, book, now=NOW)
    assert not plan.approved
    assert "floor" not in plan.model_dump_json().lower()
    assert plan.expectedUsd > 0
    assert plan.decisions[-1].action == Action.RECYCLE


def test_cash_deadline_and_headroom(book):
    item = demo_items()[0]
    goal = Goal(mode=Mode.CASH, targetUsd=300, deadline=NOW + timedelta(hours=12))
    plan = build_plan([item], goal, book, now=NOW)
    assert (plan.expectedUsd, plan.goalGapUsd) == (160, 140)
    assert plan.decisions[0].listUsd == 165


def test_normal_and_max_tiers(book):
    item = demo_items()[0]
    assert build_plan([item], Goal(mode=Mode.CASH, targetUsd=300), book, now=NOW).expectedUsd == 185
    assert build_plan([item], Goal(mode=Mode.CASH, targetUsd=100), book, now=NOW).expectedUsd == 210


def test_zero_target_does_not_force_max_tier(book):
    plan = build_plan([demo_items()[0]], Goal(mode=Mode.ZERO_WASTE), book, now=NOW)
    assert plan.expectedUsd == 185


def test_routing_keep_overrides_recycling_and_yard_sale_sells_cables(book):
    items = demo_items()
    plan = build_plan(items, Goal(mode=Mode.ZERO_WASTE), book, keep_ids={items[-1].id}, now=NOW)
    assert plan.decisions[-1].action == Action.KEEP
    assert plan.decisions[-2].action == Action.DONATE
    yard = build_plan(items, Goal(mode=Mode.YARD_SALE), book, now=NOW)
    assert yard.decisions[-2].action == Action.SELL
    assert yard.decisions[-1].action == Action.RECYCLE


def test_upgrade_gap_is_derived_from_budget(book):
    goal = Goal(mode=Mode.UPGRADE, upgradeTo="console.ps5", budgetUsd=150)
    plan = build_plan([demo_items()[0]], goal, book, now=NOW)
    assert plan.goalGapUsd == 450 - 150 - 185


def test_plan_is_deterministic_and_rejects_duplicate_ids(book):
    items, goal = demo_items(), Goal(mode=Mode.CASH, targetUsd=300)
    assert build_plan(items, goal, book, now=NOW) == build_plan(items, goal, book, now=NOW)
    with pytest.raises(ValueError, match="Duplicate"):
        build_plan([items[0], items[0]], goal, book)


def test_unknown_and_unresolved_items_cannot_be_sold(book):
    item = demo_items()[0].model_copy(update={"category": "other.unknown"})
    with pytest.raises(ValueError, match="Resolve"):
        build_plan([item], Goal(mode=Mode.CASH), book)
    item = demo_items()[0].model_copy(update={"confirmedByUser": False, "confidence": 0.4})
    with pytest.raises(ValueError, match="Resolve"):
        build_plan([item], Goal(mode=Mode.CASH), book)
    assert (
        build_plan([item], Goal(mode=Mode.CASH), book, keep_ids={item.id}).decisions[0].action
        == Action.KEEP
    )


def test_invalid_goal_inputs():
    for data in [
        {"mode": "UPGRADE"},
        {"mode": "CASH", "targetUsd": -1},
        {"mode": "CASH", "targetUsd": 1.5},
        {"mode": "CASH", "deadline": "2026-09-20T12:00:00"},
    ]:
        with pytest.raises(ValidationError):
            Goal.model_validate(data)


def test_unknown_category_and_ambiguity_produce_questions(book, capture):
    result = VisionResult(
        containsPeople=False,
        items=[observation(category="invented.category"), observation(variantAmbiguous=True)],
    )
    items = items_from_observations(result, capture, book)
    assert items[0].category == "other.unknown"
    assert items[0].confidence == 0.95  # price coverage does not reduce identity confidence
    assert all(item.question is not None for item in items)


def test_dedupe_preserves_two_objects_in_same_frame_and_owner_corrections(book, capture):
    result = VisionResult(containsPeople=False, items=[observation(), observation()])
    first = items_from_observations(result, capture, book)
    assert len(merge_scan_items([], first)) == 2
    assert len(merge_scan_items(first, first)) == 2  # replay is idempotent
    first[0].confirmedByUser = True
    first[0].condition = Condition.BROKEN
    second_capture = capture.model_copy(update={"id": "cap_other"})
    second = items_from_observations(result, second_capture, book)
    merged = merge_scan_items(first, second)
    assert len(merged) == 2
    assert all(item.captureIds == ["cap_test", "cap_other"] for item in merged)
    assert merged[0].condition == Condition.BROKEN
    assert first[0].captureIds == ["cap_test"]  # no mutation
    assert merge_scan_items(merged, second) == merged  # replay a merged frame


def test_confirm_plan_and_listing_api(book):
    client = TestClient(create_app(book))
    item = demo_items()[0].model_copy(
        update={
            "confirmedByUser": False,
            "question": Question(text="Which model?", options=["Slim", "Not sure"]),
        }
    )
    assert client.post("/listing-draft", json=item.model_dump(mode="json")).status_code == 422
    response = client.post(
        "/items/confirm",
        json={
            "item": item.model_dump(mode="json"),
            "label": "Sony PS4 Slim",
            "category": item.category,
            "condition": "FAIR",
            "confirmed": True,
        },
    )
    assert response.status_code == 200
    confirmed = response.json()["item"]
    assert confirmed["confirmedByUser"] and confirmed["question"] is None
    plan = client.post(
        "/plan", json={"items": [confirmed], "goal": {"mode": "CASH", "targetUsd": 300}}
    )
    assert plan.status_code == 200
    assert plan.json()["expectedUsd"] == 150
    draft = client.post("/listing-draft", json=confirmed)
    assert draft.status_code == 200
    assert "fair" in draft.json()["description"]


def test_identify_api_and_dog_frame_filter(book, capture):
    provider = SimpleNamespace(
        identify=AsyncMock(return_value=VisionResult(containsPeople=True, items=[observation()]))
    )
    client = TestClient(create_app(book, provider))
    payload = {"capture": capture.model_dump(mode="json"), "imageBase64": image_base64()}
    phone = client.post("/identify", json=payload)
    assert phone.status_code == 200
    assert len(phone.json()["items"]) == 1
    payload["capture"]["source"] = "DOG"
    dog = client.post("/identify", json=payload)
    assert dog.status_code == 200
    assert dog.json()["dropped"] and dog.json()["items"] == []


def test_missing_credentials_and_provider_failures_are_explicit(book, capture, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("RELOOP_VISION_MODEL", raising=False)
    payload = {"capture": capture.model_dump(mode="json"), "imageBase64": image_base64()}
    assert TestClient(create_app(book)).post("/identify", json=payload).status_code == 503
    provider = SimpleNamespace(identify=AsyncMock(side_effect=RuntimeError("secret error detail")))
    response = TestClient(create_app(book, provider)).post("/identify", json=payload)
    assert response.status_code == 502
    assert "secret" not in response.text


@pytest.mark.parametrize("encoded", ["not-base64", base64.b64encode(b"not an image").decode()])
def test_invalid_image_rejected(encoded):
    with pytest.raises(ValueError):
        decode_image(encoded)


def test_sdk_request_and_response_contract(book, capture):
    import asyncio

    provider = AnthropicVision(model="test-model", api_key="test-key")
    create = AsyncMock(
        return_value=SimpleNamespace(
            stop_reason="tool_use",
            content=[
                SimpleNamespace(
                    type="tool_use",
                    name="record_items",
                    input={
                        "containsPeople": False,
                        "items": [observation().model_dump(mode="json")],
                    },
                )
            ],
        )
    )
    provider.client = SimpleNamespace(messages=SimpleNamespace(create=create))
    result = asyncio.run(
        provider.identify(
            b"test-image",
            "image/png",
            capture,
            {key: row.label for key, row in book.entries.items()},
        )
    )
    assert len(result.items) == 1
    request = create.call_args.kwargs
    schema = request["tools"][0]["input_schema"]
    assert "other.unknown" in schema["$defs"]["Observation"]["properties"]["category"]["enum"]
    assert "image" == request["messages"][0]["content"][0]["type"]
