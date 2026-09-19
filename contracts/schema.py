from __future__ import annotations

from enum import Enum
from typing import Annotated

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

Money = Annotated[int, Field(strict=True, ge=0)]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Source(str, Enum):
    PHONE = "PHONE"
    GLASSES = "GLASSES"
    DOG = "DOG"
    FIXTURE = "FIXTURE"


class Condition(str, Enum):
    LIKE_NEW = "LIKE_NEW"
    GOOD = "GOOD"
    FAIR = "FAIR"
    POOR = "POOR"
    BROKEN = "BROKEN"


class Mode(str, Enum):
    CASH = "CASH"
    CLEAR_OUT = "CLEAR_OUT"
    ZERO_WASTE = "ZERO_WASTE"
    UPGRADE = "UPGRADE"
    YARD_SALE = "YARD_SALE"


class Action(str, Enum):
    SELL = "SELL"
    DONATE = "DONATE"
    RECYCLE = "RECYCLE"
    KEEP = "KEEP"


class Capture(Contract):
    id: str = Field(min_length=1)
    ts: AwareDatetime
    source: Source
    uri: str = Field(min_length=1)
    spot: str | None = None
    missionId: str | None = None


class Question(Contract):
    text: str = Field(min_length=1)
    options: list[str] = Field(min_length=2, max_length=3)


class Item(Contract):
    id: str = Field(min_length=1)
    captureIds: list[str] = Field(min_length=1)
    label: str = Field(min_length=1)
    category: str = Field(min_length=1)
    condition: Condition
    confidence: float = Field(ge=0, le=1, allow_inf_nan=False)
    foundBy: Source
    question: Question | None = None
    confirmedByUser: bool = False


class PriceBand(Contract):
    quickUsd: Money
    normalUsd: Money
    maxUsd: Money
    basis: str


class Goal(Contract):
    mode: Mode
    targetUsd: Money | None = None
    deadline: AwareDatetime | None = None
    upgradeTo: str | None = None
    budgetUsd: Money | None = None

    @model_validator(mode="after")
    def validate_upgrade(self):
        if self.mode == Mode.UPGRADE and (not self.upgradeTo or self.budgetUsd is None):
            raise ValueError("UPGRADE requires upgradeTo and budgetUsd")
        return self


class Decision(Contract):
    itemId: str
    action: Action
    band: PriceBand | None = None
    listUsd: Money | None = None
    reason: str


class Plan(Contract):
    id: str
    goal: Goal
    decisions: list[Decision]
    expectedUsd: Money
    goalGapUsd: Money
    approved: bool = False
