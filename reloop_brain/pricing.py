from __future__ import annotations

import csv
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from contracts.schema import Condition, Item, PriceBand
from reloop_brain.evidence import EvidenceSet, load_evidence

MULTIPLIERS = {
    Condition.LIKE_NEW: Decimal("1.10"),
    Condition.GOOD: Decimal("1.00"),
    Condition.FAIR: Decimal("0.80"),
    Condition.POOR: Decimal("0.55"),
    Condition.BROKEN: Decimal("0.15"),
}


class PriceEntry(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    category: str = Field(min_length=1)
    label: str = Field(min_length=1)
    normal_usd: Decimal = Field(gt=0, allow_inf_nan=False)
    spread_pct: Decimal = Field(ge=0, lt=100, allow_inf_nan=False)
    min_listable_usd: int = Field(ge=0)
    e_waste: bool
    source: str = Field(min_length=1)
    researched: date | None = None
    is_demo: bool = True
    rounding_usd: int = Field(default=5, ge=1, le=5)


class PriceBook:
    def __init__(self, entries: list[PriceEntry]):
        self.evidence: dict[str, EvidenceSet] = {}
        self.entries = {entry.category: entry for entry in entries}
        if not entries or len(self.entries) != len(entries):
            raise ValueError("Price book must be nonempty and have unique categories")

    def with_evidence(self, path: Path, *, today: date | None = None) -> PriceBook:
        today = today or datetime.now(UTC).date()
        evidence = load_evidence(path)
        for category, record in evidence.items():
            normal = record.normal_value(today)
            if normal is None:
                continue
            used = record.usable(today)
            source = (
                f"Median of {len(used)} good/used-ungraded sold-page displayed prices "
                "(not verified final transactions); " + "; ".join(str(c.url) for c in used)
            )
            self.entries[category] = PriceEntry(
                category=category,
                label=record.label,
                normal_usd=normal,
                spread_pct=record.spreadPct,
                min_listable_usd=record.minListableUsd,
                e_waste=record.eWaste,
                source=source,
                researched=min(c.observedAt for c in used),
                is_demo=False,
                rounding_usd=record.roundingUsd,
            )
        self.evidence = evidence
        return self

    @classmethod
    def load(cls, path: Path, *, allow_demo: bool = False) -> PriceBook:
        with path.open(newline="", encoding="utf-8") as stream:
            rows = list(csv.DictReader(stream))
        entries = []
        for row in rows:
            row["researched"] = row.get("researched") or None
            entry = PriceEntry.model_validate(row)
            if entry.is_demo and not allow_demo:
                raise ValueError(
                    "Fixture prices are disabled. Research the price book or set "
                    "RELOOP_ALLOW_DEMO_PRICES=1 for an explicitly labeled demo."
                )
            if not entry.is_demo and entry.researched is None:
                raise ValueError(f"Missing research date: {entry.category}")
            entries.append(entry)
        return cls(entries)

    def get(self, category: str) -> PriceEntry:
        try:
            return self.entries[category]
        except KeyError as exc:
            raise ValueError(
                f"No researched price category for {category}; confirm/reclassify first"
            ) from exc


def round5(value: Decimal) -> int:
    return int((value / 5).quantize(Decimal(1), rounding=ROUND_HALF_UP) * 5)


def price_item(item: Item, book: PriceBook) -> PriceBand:
    row = book.get(item.category)
    multiplier = MULTIPLIERS[item.condition]

    def rounded(value):
        return int(
            (value / row.rounding_usd).quantize(Decimal(1), rounding=ROUND_HALF_UP)
            * row.rounding_usd
        )

    normal = rounded(row.normal_usd * multiplier)
    spread = row.spread_pct / 100
    prefix = "DEMO ESTIMATE - NOT MARKET RESEARCH; " if row.is_demo else ""
    basis = (
        f"{prefix}{row.category}; {item.condition.value} x{multiplier}; "
        f"{row.source}; researched {row.researched or 'not researched'}"
    )
    return PriceBand(
        quickUsd=rounded(Decimal(normal) * (1 - spread)),
        normalUsd=normal,
        maxUsd=rounded(Decimal(normal) * (1 + spread)),
        basis=basis,
    )
