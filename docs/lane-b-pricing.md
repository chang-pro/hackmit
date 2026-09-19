# Lane B pricing handoff

`POST /price` accepts the existing camelCase `Item` object. It returns:
`itemId`, `status`, `band`, `suggestedAskUsd`, `evidenceQuality`,
`usedComparableCount`, `comparables`, and `warnings`.

`POST /identify` and `/items/confirm` now add `pricingStatus` to each priced item.
The shared Item and PriceBand fields are unchanged.

Statuses:
- `NEEDS_CONFIRMATION`: identity/variant/condition question pending; any band is provisional.
- `NEEDS_RESEARCH`: identity can be known while pricing is unavailable; never render this as $0.
- `DEMO`: explicitly unresearched fixture price.
- `ESTIMATE`: researched estimate, still not a guaranteed sale price.

## Sources and method

`data/pricing_evidence.json` contains human-reviewed sources with URLs, observation
dates, sold dates when available, separate item/shipping amounts, and evidence kind.
No live scraping or model-generated prices occur in this endpoint.

Only matching single-item sold-page displays in GOOD or USED_UNGRADED condition
enter the median. Ungraded used items are assumed GOOD as a baseline, explicitly
disclosed. Retail and active asking prices remain visible but do not enter the
median. References older than 90 days from observation or 180 days from a known
sale date are excluded. An unknown sale date remains a stated limitation.
At least two distinct reviewed source URLs are required. This does not prove two
independent verified transactions. Cached pages and index-only excerpts are noted.

Median item price -> condition multiplier -> configured rounding -> quick/max
policy spread. These tiers do not estimate probability or time to sale. Shipping
is recorded but excluded from the median; free-shipping sellers may embed delivery
costs in their price. Values are gross before seller fees, delivery, or tax.
All current researched sets have LOW evidence quality, due to small samples and
displayed prices that may differ from final negotiated payments.

## Current researched coverage

| Category | GOOD quick / normal / max | Suggested ask | Evidence |
| --- | --- | --- | --- |
| `accessories.rayban_regular_case` | $8 / $10 / $12 | $11 | 3 displayed sold-page prices: $3.49, $9.99, $9.99 |
| `accessories.rayban_meta_charging_case` | $30 / $40 / $50 | $42 | 2 displayed sold-page prices: $29.99, $52 |

The regular case rounds to $1 rather than $5. Charging cases are electronics;
ordinary glasses cases are not. The photo must not imply hidden glasses are included.
`accessories.rayban_case_unspecified` requires choosing which type before planning.

The existing online listing minimum is $15, so the regular case routes to proposed
donation in ordinary goal modes and to SELL in YARD_SALE. The price endpoint still
shows its value; routing is a separate decision. Nobody has approved a sale.

Other existing categories still use labeled fixtures. To add coverage, add a
reviewed EvidenceSet with category, label, eWaste, spreadPct, minListableUsd,
roundingUsd and comparables. The API automatically loads it on each request and
the same derived PriceEntry feeds planning. Override the file with
`RELOOP_PRICING_EVIDENCE=/absolute/path/to/evidence.json` if needed.

## Integration with the newer Node live view

`services/vision/backends/rightcodes-items.js` currently emits model-generated
`price_usd` values. This change does not replace that teammate-owned pipeline.
To consume Lane B pricing, map a confirmed detection to Item/category, call `/price`,
and use `band.normalUsd` plus status/basis. Do not label the existing model estimates
as researched comparables. The item bounding box can stay in the Node layer.

Local API tests run with `.venv/bin/python -m pytest -q`.
