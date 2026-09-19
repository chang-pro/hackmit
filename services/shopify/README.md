# Shopify Listing Interface

This service publishes approved items directly to your Shopify store (`reloop-dev.myshopify.com`)
as live, purchasable products with complete descriptions, condition tags, and market appraisal basis.

ReLoop identifies an item and suggests a price via the visual intelligence pipeline.
Users will be able to review a listing and adjust parameters such as pricing before publishing.

Zero external dependencies: uses native Node `fetch` against the Shopify GraphQL Admin API.

## Setup

Set the following in `.env` at the repository root:

```env
SHOPIFY_STORE_DOMAIN=reloop-dev.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxx
```

If `SHOPIFY_ADMIN_ACCESS_TOKEN` is omitted (or `DRY_RUN=1`), the client runs in **dry-run mode**,
logging the request and returning simulated product URLs without calling the live API.

### Getting your Shopify Access Token (takes 60 seconds)

1. Open your Shopify admin at `https://reloop-dev.myshopify.com/admin`.
2. Navigate to **Settings** (bottom left) $\to$ **Apps and sales channels** $\to$ **Develop apps**.
3. Click **Create an app** (name it `ReLoop Agent`).
4. Click **Configure Admin API scopes**, and enable:
   - `write_products`
   - `read_products`
5. Click **Install app** $\to$ reveal and copy the **Admin API access token** (`shpat_...`).

## Usage

```javascript
import { publishShopifyListing } from "./services/shopify/shopify-agent.js";

const result = await publishShopifyListing({
  id: "item_001",
  label: "Sony PS4 Slim",
  condition: "good",
  price_usd: 185,
  price_basis: "used PS4 Slim consoles sell around $185",
  foundBy: "DOG", // or "PHONE" or "GLASSES"
});

console.log(result.product.url);
// -> https://reloop-dev.myshopify.com/products/sony-ps4-slim
```

## Testing

Run the test script:

```bash
node scripts/test-shopify.js
```

Run automated tests:

```bash
npm test
```
