"""Offline Lane B proof: python -m reloop_brain.demo [--write-fixtures]."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path

from contracts.schema import Condition, Goal, Item, Mode, Source
from reloop_brain.planner import build_plan
from reloop_brain.pricing import PriceBook
from reloop_brain.service import price_items

ROOT = Path(__file__).resolve().parents[1]


def demo_items() -> list[Item]:
    examples = [
        ("ps4", "Sony PS4 Slim", "console.ps4_slim", Condition.GOOD),
        ("headset", "Wireless gaming headset", "audio.headset_wireless", Condition.GOOD),
        ("monitor", "24 inch 1080p monitor", "display.monitor_24", Condition.GOOD),
        ("phone", "Old phone (fixture)", "phone.generic", Condition.GOOD),
        ("keyboard", "Keyboard", "input.keyboard", Condition.GOOD),
        ("lamp", "Desk lamp", "lighting.desk_lamp", Condition.GOOD),
        ("cables", "Cable bundle", "accessories.cables", Condition.GOOD),
        ("dead_phone", "Dead phone (fixture)", "phone.generic", Condition.BROKEN),
    ]
    return [
        Item(
            id=f"it_{key}",
            captureIds=[f"cap_{key}"],
            label=label,
            category=category,
            condition=condition,
            confidence=0.95,
            foundBy=Source.FIXTURE,
            confirmedByUser=True,
        )
        for key, label, category, condition in examples
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-fixtures", action="store_true")
    args = parser.parse_args()
    book = PriceBook.load(ROOT / "data/price_book.csv", allow_demo=True)
    items = demo_items()
    goal = Goal(mode=Mode.CASH, targetUsd=300)
    plan = build_plan(items, goal, book, now=datetime(2026, 9, 19, 12, tzinfo=UTC))
    if args.write_fixtures:
        directory = ROOT / "contracts/fixtures"
        directory.mkdir(parents=True, exist_ok=True)
        artifacts = {
            "items.json": [item.model_dump(mode="json") for item in items],
            "priced_items.json": [
                item.model_dump(mode="json") for item in price_items(items, book)
            ],
            "plan_request.json": {
                "items": [item.model_dump(mode="json") for item in items],
                "goal": goal.model_dump(mode="json"),
                "keepItemIds": [],
            },
            "plan.json": plan.model_dump(mode="json"),
        }
        for name, data in artifacts.items():
            (directory / name).write_text(json.dumps(data, indent=2) + "\n")
    print("DEMO ONLY: unresearched prices; synthetic item observations; no vision API called.")
    for decision in plan.decisions:
        print(
            f"{decision.itemId:16} {decision.action.value:7} list={decision.listUsd} | {decision.reason}"
        )
    print(f"Expected ${plan.expectedUsd}; gap ${plan.goalGapUsd}; approved={plan.approved}")


if __name__ == "__main__":
    main()
