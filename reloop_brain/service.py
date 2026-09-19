from __future__ import annotations

from contracts.schema import Contract, Item, PriceBand
from reloop_brain.pricing import PriceBook, price_item


class PricedItem(Contract):
    item: Item
    band: PriceBand | None = None


class ListingDraft(Contract):
    itemId: str
    title: str
    description: str
    priceBasis: str


def price_items(items: list[Item], book: PriceBook) -> list[PricedItem]:
    return [
        PricedItem(
            item=item, band=price_item(item, book) if item.category in book.entries else None
        )
        for item in items
    ]


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
