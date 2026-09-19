"""Recognizable categories need not yet have price evidence."""

EXTRA_CATEGORIES = {
    "accessories.rayban_case_unspecified": "Ray-Ban case; charging versus ordinary case unconfirmed",
    "accessories.rayban_regular_case": "Ordinary Ray-Ban glasses case; no charging electronics",
    "accessories.rayban_meta_charging_case": "Ray-Ban Meta brown charging case only, no glasses",
}


def recognition_categories(book):
    return {**EXTRA_CATEGORIES, **{key: entry.label for key, entry in book.entries.items()}}
