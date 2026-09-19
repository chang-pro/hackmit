"""Offline, human-reviewed comparable prices. No runtime scraping or LLM prices."""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from statistics import median
from typing import Literal

from pydantic import Field, HttpUrl

from contracts.schema import Condition, Contract


class Comparable(Contract):
    url: HttpUrl
    title: str
    itemPriceUsd: Decimal = Field(gt=0, allow_inf_nan=False)
    shippingUsd: Decimal | None = Field(default=None, ge=0, allow_inf_nan=False)
    currency: Literal["USD"] = "USD"
    condition: Condition | Literal["USED_UNGRADED"]
    kind: Literal["SOLD_PAGE_DISPLAY", "ASKING", "RETAIL"]
    observedAt: date
    soldAt: date | None = None
    exactMatch: bool = True
    quantity: int = Field(default=1, ge=1)
    notes: str = ""


class EvidenceSet(Contract):
    category: str
    label: str
    minListableUsd: int = Field(default=15, ge=0)
    eWaste: bool
    spreadPct: int = Field(default=20, ge=0, lt=100)
    roundingUsd: int = Field(default=5, ge=1, le=5)
    comparables: list[Comparable]

    def usable(self, today: date) -> list[Comparable]:
        return [
            c
            for c in self.comparables
            if c.exactMatch
            and c.quantity == 1
            and c.condition in (Condition.GOOD, "USED_UNGRADED")
            and c.kind == "SOLD_PAGE_DISPLAY"
            and 0 <= (today - c.observedAt).days <= 90
            and (c.soldAt is None or 0 <= (today - c.soldAt).days <= 180)
        ]

    def normal_value(self, today: date) -> Decimal | None:
        candidates = self.usable(today)
        # Two distinct source URLs are the minimum for this deliberately small MVP.
        if len(candidates) < 2:
            return None
        return median(c.itemPriceUsd for c in candidates)


def load_evidence(path: Path) -> dict[str, EvidenceSet]:
    records = [EvidenceSet.model_validate(row) for row in json.loads(path.read_text())]
    if len({record.category for record in records}) != len(records):
        raise ValueError("Duplicate evidence category")
    for record in records:
        urls = [str(c.url) for c in record.comparables]
        if len(set(urls)) != len(urls):
            raise ValueError("Duplicate comparable source URL")
    return {record.category: record for record in records}
