import test from "node:test";
import assert from "node:assert/strict";
import {
  createProduct,
  shopifyGraphql,
  ShopifyError,
} from "../services/shopify/shopify-client.js";
import {
  publishShopifyListing,
  buildDescriptionHtml,
} from "../services/shopify/shopify-agent.js";

test("buildDescriptionHtml formats readable details", () => {
  const item = {
    label: "Mechanical Keyboard",
    condition: "like_new",
    price_basis: "recent eBay sold avg $95",
    foundBy: "DOG",
  };
  const html = buildDescriptionHtml(item, { note: "Cherry MX switches" });
  assert.ok(html.includes("Mechanical Keyboard"));
  assert.ok(html.includes("Like New"));
  assert.ok(html.includes("recent eBay sold avg $95"));
  assert.ok(html.includes("DOG"));
  assert.ok(html.includes("Cherry MX switches"));
});

test("publishShopifyListing succeeds in dry-run mode", async () => {
  const item = {
    id: "item_999",
    label: "Wireless gaming headset",
    condition: "good",
    price_usd: 45,
    price_basis: "fair condition baseline",
    foundBy: "GLASSES",
  };

  const result = await publishShopifyListing(item);
  assert.equal(result.success, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.item_id, "item_999");
  assert.equal(result.product.title, "Wireless gaming headset");
  assert.equal(result.product.price, "45.00");
  assert.ok(result.product.url.includes("wireless-gaming-headset"));
});

test("createProduct sends expected GraphQL payload", async () => {
  let capturedUrl = null;
  let capturedBody = null;
  let capturedHeaders = null;

  const mockFetch = async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    capturedHeaders = options.headers;

    return {
      ok: true,
      json: async () => ({
        data: {
          productCreate: {
            product: {
              id: "gid://shopify/Product/12345",
              title: "Test Item",
              handle: "test-item",
              status: "ACTIVE",
              variants: {
                nodes: [{ id: "gid://shopify/ProductVariant/67890", price: "50.00" }],
              },
            },
            userErrors: [],
          },
        },
      }),
    };
  };

  // Temporarily set a dummy token to test live fetch call path
  const prevToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "shpat_test_mock_token";

  try {
    const result = await createProduct({
      title: "Test Item",
      descriptionHtml: "<p>Hello</p>",
      price: 50,
      tags: ["tag1", "tag2"],
      customFetch: mockFetch,
    });

    assert.equal(result.dry_run, false);
    assert.equal(result.product.id, "gid://shopify/Product/12345");
    assert.equal(result.product.price, "50.00");
    assert.equal(result.product.url, "https://reloop-dev.myshopify.com/products/test-item");
    assert.equal(
      capturedHeaders["X-Shopify-Access-Token"],
      "shpat_test_mock_token"
    );
    assert.equal(capturedBody.variables.input.title, "Test Item");
    assert.equal(capturedBody.variables.input.variants[0].price, "50.00");
  } finally {
    if (prevToken === undefined) {
      delete process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
    } else {
      process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = prevToken;
    }
  }
});

test("createProduct throws ShopifyError when userErrors present", async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      data: {
        productCreate: {
          product: null,
          userErrors: [{ field: ["title"], message: "Title cannot be blank" }],
        },
      },
    }),
  });

  const prevToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "shpat_test_mock_token";

  try {
    await assert.rejects(
      async () => {
        await createProduct({
          title: "",
          descriptionHtml: "",
          price: 10,
          customFetch: mockFetch,
        });
      },
      (err) => {
        assert.ok(err instanceof ShopifyError);
        assert.ok(err.message.includes("Title cannot be blank"));
        return true;
      }
    );
  } finally {
    if (prevToken === undefined) {
      delete process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
    } else {
      process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = prevToken;
    }
  }
});

