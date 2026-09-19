from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

from fastapi.testclient import TestClient

from contracts.schema import Condition, Goal, Mode
from reloop_brain.api import create_app
from reloop_brain.catalog import recognition_categories
from reloop_brain.demo import demo_items
from reloop_brain.evidence import load_evidence
from reloop_brain.planner import build_plan
from reloop_brain.pricing import PriceBook
from reloop_brain.service import quote_item

ROOT = Path(__file__).resolve().parents[1]
KEY = "accessories.rayban_meta_charging_case"


def book_with_evidence():
    return PriceBook.load(ROOT / "data/price_book.csv", allow_demo=True).with_evidence(
        ROOT / "data/pricing_evidence.json", today=date(2026, 9, 19)
    )


def case_item(category=KEY):
    return demo_items()[0].model_copy(
        update={"id": "it_case", "category": category, "label": "Ray-Ban Meta charging case only"}
    )


def test_only_matching_sold_pages_drive_median():
    record = load_evidence(ROOT / "data/pricing_evidence.json")[KEY]
    assert record.normal_value(date(2026, 9, 19)) == Decimal("40.995")
    assert len(record.usable(date(2026, 9, 19))) == 2
    # Asking prices, bundles, broken items and mismatched products are not comparable.
    for update in (
        {"kind": "ASKING"},
        {"quantity": 2},
        {"exactMatch": False},
        {"condition": Condition.BROKEN},
    ):
        modified = record.model_copy(deep=True)
        modified.comparables[0] = modified.comparables[0].model_copy(update=update)
        assert modified.normal_value(date(2026, 9, 19)) is None
    assert record.normal_value(date(2026, 9, 19) + timedelta(days=91)) is None


def test_price_endpoint_and_plan_use_same_researched_band():
    book = book_with_evidence()
    client = TestClient(create_app(book))
    item = case_item()
    response = client.post("/price", json=item.model_dump(mode="json"))
    assert response.status_code == 200
    quote = response.json()
    assert quote["status"] == "ESTIMATE"
    assert quote["evidenceQuality"] == "LOW"
    assert quote["usedComparableCount"] == 2
    assert len(quote["comparables"]) == 3
    assert (quote["band"]["quickUsd"], quote["band"]["normalUsd"], quote["band"]["maxUsd"]) == (
        30,
        40,
        50,
    )
    assert quote["suggestedAskUsd"] == 42
    assert "https://" in quote["band"]["basis"]
    plan = build_plan([item], Goal(mode=Mode.CASH, targetUsd=300), book)
    assert plan.expectedUsd == 40 and plan.decisions[0].listUsd == 42


def test_recognized_but_unpriced_is_not_a_bad_identification():
    book = PriceBook.load(ROOT / "data/price_book.csv", allow_demo=True)
    item = case_item("accessories.rayban_regular_case")
    assert item.category in recognition_categories(book)
    quote = quote_item(item, book)
    assert quote.status == "NEEDS_RESEARCH" and quote.band is None
    assert item.confidence == 0.95


def test_regular_case_can_be_confirmed_without_inventing_a_price():
    client = TestClient(create_app(PriceBook.load(ROOT / "data/price_book.csv", allow_demo=True)))
    response = client.post(
        "/items/confirm",
        json={
            "item": case_item().model_dump(mode="json"),
            "label": "Regular Ray-Ban case",
            "category": "accessories.rayban_regular_case",
            "condition": "GOOD",
            "confirmed": True,
        },
    )
    assert response.status_code == 200
    assert response.json()["pricingStatus"] == "NEEDS_RESEARCH"
    assert response.json()["band"] is None


def test_regular_case_price_does_not_use_charging_case_comparables():
    book = book_with_evidence()
    item = case_item("accessories.rayban_regular_case")
    quote = quote_item(item, book)
    assert (quote.band.quickUsd, quote.band.normalUsd, quote.band.maxUsd) == (8, 10, 12)
    assert quote.usedComparableCount == 3
    assert quote.suggestedAskUsd == 11
    assert all("charging" not in c.title.lower() for c in quote.comparables)
    assert not book.get(item.category).e_waste


def test_new_identification_keeps_unpriced_category_and_confidence():
    from contracts.schema import Capture, Source
    from reloop_brain.identify import Observation, VisionResult, items_from_observations

    book = PriceBook.load(ROOT / "data/price_book.csv", allow_demo=True)
    capture = Capture(
        id="cap_case", ts="2026-09-19T12:00:00Z", source=Source.PHONE, uri="blob://case"
    )
    result = VisionResult(
        containsPeople=False,
        items=[
            Observation(
                label="Ray-Ban glasses case",
                category="accessories.rayban_regular_case",
                condition=Condition.GOOD,
                confidence=0.95,
            )
        ],
    )
    item = items_from_observations(result, capture, book)[0]
    assert item.category == "accessories.rayban_regular_case" and item.confidence == 0.95
    assert item.question is not None
    assert quote_item(item, book).band is None
