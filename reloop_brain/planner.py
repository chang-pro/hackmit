from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from decimal import ROUND_CEILING, Decimal

from contracts.schema import Action, Condition, Decision, Goal, Item, Mode, Plan
from reloop_brain.pricing import PriceBook, price_item


def build_plan(
    items: list[Item],
    goal: Goal,
    book: PriceBook,
    *,
    keep_ids: set[str] | None = None,
    now: datetime | None = None,
) -> Plan:
    now = now or datetime.now(UTC)
    if now.utcoffset() is None:
        raise ValueError("now must have a timezone")
    keep_ids = keep_ids or set()
    ids = [item.id for item in items]
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate item IDs; deduplicate the scan first")
    if keep_ids - set(ids):
        raise ValueError("keepItemIds includes an item outside this plan")
    for item in items:
        if item.id not in keep_ids and (
            item.category == "other.unknown"
            or (not item.confirmedByUser and (item.question or item.confidence < 0.75))
        ):
            raise ValueError(f"Resolve identification question for {item.id} before planning")

    target = goal.targetUsd or 0
    if goal.mode == Mode.UPGRADE:
        target = max(
            0,
            int(book.get(goal.upgradeTo).normal_usd.to_integral_value(rounding=ROUND_CEILING))
            - goal.budgetUsd,
        )
    priced = {}
    actions = {}
    reasons = {}
    for item in items:
        if item.id in keep_ids:
            actions[item.id], reasons[item.id] = Action.KEEP, "You marked this item to keep."
            continue
        row = book.get(item.category)
        band = priced[item.id] = price_item(item, book)
        if item.condition == Condition.BROKEN:
            actions[item.id] = Action.RECYCLE
            reasons[item.id] = (
                "Broken electronic: route to an e-waste collection site."
                if row.e_waste
                else "Broken item: check local material recovery rules."
            )
        elif goal.mode == Mode.YARD_SALE:
            actions[item.id] = Action.SELL if band.normalUsd >= 2 else Action.DONATE
            reasons[item.id] = "In-person sale bypasses the online listing minimum."
        elif band.normalUsd < row.min_listable_usd:
            actions[item.id] = Action.DONATE
            reasons[item.id] = (
                f"Estimated ${band.normalUsd} is below the ${row.min_listable_usd} "
                "listing minimum; propose donation if accepted and usable."
            )
        else:
            actions[item.id] = Action.SELL

    sell = [item for item in items if actions[item.id] == Action.SELL]
    normal_total = sum(priced[item.id].normalUsd for item in sell)
    hours = (goal.deadline - now).total_seconds() / 3600 if goal.deadline else 72
    if goal.mode in (Mode.CLEAR_OUT, Mode.YARD_SALE) or hours < 24:
        tier, tier_reason = "quickUsd", "Quick-sale tier for clearance or a short deadline"
    elif target > 0 and normal_total >= Decimal(target) * Decimal("1.3"):
        tier, tier_reason = (
            "maxUsd",
            "Higher tier: estimated normal value exceeds the target by 30%",
        )
    else:
        tier, tier_reason = "normalUsd", "Normal tier balances expected value and speed"

    decisions = []
    expected = 0
    for item in items:
        action, band = actions[item.id], priced.get(item.id)
        listing_price = None
        reason = reasons.get(item.id, "")
        if action == Action.SELL:
            estimated = getattr(band, tier)
            # Never create a zero-dollar sell decision after rounding very cheap items.
            estimated = max(2, estimated)
            expected += estimated
            listing_price = int(
                (Decimal(estimated) * Decimal("1.03")).to_integral_value(rounding=ROUND_CEILING)
            )
            reason = f"{tier_reason}; expected ${estimated}, with 3% negotiation headroom."
            if target:
                reason += f" About {round(estimated / target * 100)}% of the ${target} target."
        decisions.append(
            Decision(itemId=item.id, action=action, band=band, listUsd=listing_price, reason=reason)
        )
    # Same effective plan has the same ID; an estimate is never an approval or sale.
    payload = {
        "goal": goal.model_dump(mode="json"),
        "decisions": [decision.model_dump(mode="json") for decision in decisions],
    }
    plan_id = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]
    return Plan(
        id=f"plan_{plan_id}",
        goal=goal,
        decisions=decisions,
        expectedUsd=expected,
        goalGapUsd=max(0, target - expected),
        approved=False,
    )
