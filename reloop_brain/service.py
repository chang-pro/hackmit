from __future__ import annotations

from datetime import UTC, datetime
from decimal import ROUND_CEILING, Decimal
from typing import Literal

from pydantic import Field

from contracts.schema import Contract, Item, PriceBand
from reloop_brain.evidence import Comparable
from reloop_brain.pricing import PriceBook, price_item


class PricedItem(Contract):
    item: Item
    band: PriceBand | None = None
    pricingStatus: Literal["ESTIMATE", "DEMO", "NEEDS_RESEARCH", "NEEDS_CONFIRMATION"] = (
        "NEEDS_RESEARCH"
    )


class PriceQuote(Contract):
    itemId: str
    status: Literal["ESTIMATE", "DEMO", "NEEDS_RESEARCH", "NEEDS_CONFIRMATION"]
    band: PriceBand | None = None
    suggestedAskUsd: int | None = None
    evidenceQuality: Literal["LOW", "DEMO", "NONE"]
    usedComparableCount: int = 0
    comparables: list[Comparable] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


def quote_item(item: Item, book: PriceBook) -> PriceQuote:
    row = book.entries.get(item.category)
    record = book.evidence.get(item.category)
    used = record.usable(datetime.now(UTC).date()) if record else []
    pending = not item.confirmedByUser and (item.question is not None or item.confidence < 0.75)
    warnings = [
        "Gross estimate before seller fees and shipping; sale price and time are not guaranteed."
    ]
    if row is None:
        return PriceQuote(
            itemId=item.id,
            status="NEEDS_CONFIRMATION" if pending else "NEEDS_RESEARCH",
            evidenceQuality="NONE",
            comparables=record.comparables if record else [],
            warnings=[
                "Recognized identity does not imply price coverage. Add reviewed comparables."
            ],
        )
    band = price_item(item, book)
    if record:
        warnings += [
            "Small sample of publicly displayed prices on sold pages, not verified payments.",
            "Quick/max tiers use a policy spread, not measured sale probabilities.",
            "Listing ages may be unknown; observation date is not a sale date.",
            "Used-but-ungraded comparables are treated as GOOD baseline; condition multipliers are policy assumptions.",
        ]
    if pending:
        warnings.append(
            "Confirm model/variant and condition before relying on this provisional estimate."
        )
    return PriceQuote(
        itemId=item.id,
        status="NEEDS_CONFIRMATION" if pending else "DEMO" if row.is_demo else "ESTIMATE",
        band=band,
        suggestedAskUsd=int(
            (Decimal(band.normalUsd) * Decimal("1.03")).to_integral_value(rounding=ROUND_CEILING)
        ),
        evidenceQuality="DEMO" if row.is_demo else "LOW",
        usedComparableCount=len(used),
        comparables=record.comparables if record else [],
        warnings=warnings,
    )


class ListingDraft(Contract):
    itemId: str
    title: str
    description: str
    priceBasis: str


def price_items(items: list[Item], book: PriceBook) -> list[PricedItem]:
    result = []
    for item in items:
        quote = quote_item(item, book)
        result.append(PricedItem(item=item, band=quote.band, pricingStatus=quote.status))
    return result


def listing_draft(item: Item, book: PriceBook) -> ListingDraft:
    if not item.confirmedByUser or item.question is not None:
        raise ValueError("Owner must confirm item details before generating listing copy")
    band = price_item(item, book)
    condition = item.condition.value.lower().replace("_", " ")
    return ListingDraft(
        itemId=item.id,
        title=item.label,
        description=f"{item.label}. Owner-reported condition: {condition}. "
        "Only photographed and owner-confirmed details are represented; "
        "accessories and functional tests are not specified.",
        priceBasis=band.basis,
    )
