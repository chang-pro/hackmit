// High-level Shopify listing agent for ReLoop.
//
// Converts identified and priced items from the vision pipeline / contracts
// into live product listings on Shopify with full formatting and pricing.

import { createProduct } from "./shopify-client.js";

const CONDITION_LABELS = {
  like_new: "Like New",
  good: "Good",
  fair: "Fair",
  poor: "Poor",
  broken: "For Parts / As-Is",
  LIKE_NEW: "Like New",
  GOOD: "Good",
  FAIR: "Fair",
  POOR: "Poor",
  BROKEN: "For Parts / As-Is",
};

/**
 * Generates customer-facing HTML description for a ReLoop item.
 */
export function buildDescriptionHtml(item, { note = null } = {}) {
  const condition = CONDITION_LABELS[item.condition] || item.condition || "Used";
  const basis = item.price_basis || item.basis || "Estimated by ReLoop market analysis";
  const source = item.foundBy || item.source || "smart scan";

  return [
    `<div>`,
    `  <p><strong>Item:</strong> ${item.label}</p>`,
    `  <p><strong>Condition:</strong> ${condition}</p>`,
    `  <p><strong>Market Appraisal Basis:</strong> ${basis}</p>`,
    `  <p><strong>Sourced By:</strong> ReLoop Visual Intelligence (${source})</p>`,
    note ? `  <p><strong>Notes:</strong> ${note}</p>` : "",
    `  <hr />`,
    `  <p><small>Verified and listed autonomously by ReLoop.</small></p>`,
    `</div>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Publishes an item to the Shopify store.
 *
 * @param {Object} item
 * @param {string} item.label - Title of item (e.g. "Sony PS4 Slim")
 * @param {number} [item.price_usd] - Price in USD (e.g. 185)
 * @param {number} [item.listUsd] - Alternative price field from Decision contract
 * @param {string} [item.condition] - Item condition
 * @param {string} [item.category] - Item category
 * @param {string} [item.price_basis] - Rationale for the price
 * @param {string} [item.foundBy] - Capture source (PHONE, GLASSES, DOG)
 * @param {string} [item.photoUrl] - Optional image URL
 * @param {Object} [options]
 * @param {"ACTIVE"|"DRAFT"} [options.status="ACTIVE"]
 * @param {string[]} [options.additionalTags=[]]
 * @param {string} [options.note]
 * @param {Function} [options.customFetch]
 */
export async function publishShopifyListing(item, options = {}) {
  if (!item || !item.label) {
    throw new Error("Item label is required to create a Shopify listing.");
  }

  const price = item.listUsd ?? item.price_usd ?? 0;
  const conditionTag = item.condition ? `condition:${item.condition.toLowerCase()}` : null;
  const categoryTag = item.category ? `category:${item.category}` : null;
  const sourceTag = item.foundBy ? `source:${item.foundBy.toLowerCase()}` : null;

  const tags = [
    "reloop",
    conditionTag,
    categoryTag,
    sourceTag,
    ...(options.additionalTags || []),
  ].filter(Boolean);

  const descriptionHtml = buildDescriptionHtml(item, { note: options.note });

  const result = await createProduct({
    title: item.label,
    descriptionHtml,
    price,
    tags,
    status: options.status || "ACTIVE",
    imageUrl: item.photoUrl || null,
    customFetch: options.customFetch,
  });

  return {
    success: true,
    item_id: item.id || null,
    dry_run: result.dry_run,
    product: result.product,
    published_at: new Date().toISOString(),
  };
}

