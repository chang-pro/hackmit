#!/usr/bin/env node

import { publishShopifyListing } from "../services/shopify/shopify-agent.js";
import { getShopifyConfig } from "../services/shopify/shopify-client.js";

async function main() {
  const config = getShopifyConfig();
  console.log("=== ReLoop Shopify Listing Test ===");
  console.log(`Store Domain: ${config.domain}`);
  console.log(`Dry Run Mode: ${config.isDryRun ? "YES (simulating)" : "NO (live API call)"}`);
  if (config.isDryRun) {
    console.log("Tip: Set SHOPIFY_ADMIN_ACCESS_TOKEN in .env for live store publication.\n");
  }

  const sampleItem = {
    id: "item_demo_ps4",
    label: "Sony PS4 Slim 500GB",
    condition: "good",
    price_usd: 185,
    price_basis: "used PS4 Slim consoles sell around $185",
    foundBy: "DOG",
    category: "console.ps4_slim",
  };

  console.log("Publishing sample item:", sampleItem.label);
  const result = await publishShopifyListing(sampleItem, {
    status: "ACTIVE",
    additionalTags: ["hackmit-2026", "demo-item"],
  });

  console.log("\nSuccess!");
  console.log("Result:", JSON.stringify(result, null, 2));
  console.log(`\nView product at: ${result.product.url}`);
  console.log(`Admin editor at: ${result.product.adminUrl}`);
}

main().catch((err) => {
  console.error("Shopify test failed:", err);
  process.exit(1);
});

