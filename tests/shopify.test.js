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
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = "1";
  try {
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
  } finally {
    if (prevDryRun !== undefined) {
      process.env.DRY_RUN = prevDryRun;
    } else {
      delete process.env.DRY_RUN;
    }
  }
});

test("createProduct sends expected GraphQL payload", async () => {
  let capturedUrl = null;
  let capturedBody = null;
  const calls = [];

  const mockFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body, headers: options.headers });

    if (body.query?.includes("ProductCreate")) {
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
                  nodes: [{ id: "gid://shopify/ProductVariant/67890", price: "0.00" }],
                },
              },
              userErrors: [],
            },
          },
        }),
      };
    }

    return {
      ok: true,
      json: async () => ({
        data: {
          productVariantsBulkUpdate: {
            productVariants: [{ id: "gid://shopify/ProductVariant/67890", price: "50.00" }],
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
      calls[0].headers["X-Shopify-Access-Token"],
      "shpat_test_mock_token"
    );
    assert.equal(calls[0].body.variables.input.title, "Test Item");
    assert.equal(calls.length >= 1, true);
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

test("only addresses Shopify's servers can reach are handed over by URL", async () => {
  // Shopify attaches an image by fetching it itself. Anything only this machine
  // or this tailnet can reach must be uploaded instead, or the product is
  // created and its photo silently never appears.
  const { isPubliclyFetchable } = await import("../services/shopify/shopify-client.js");
  for (const url of [
    "http://localhost:3000/api/photos/pho_1",
    "http://127.0.0.1:3000/x.jpg",
    "http://10.189.45.199:3000/x.jpg",       // venue LAN
    "http://192.168.234.1:3000/x.jpg",       // USB bridge
    "http://172.20.10.2:3000/x.jpg",         // phone hotspot
    "http://100.104.109.111:3000/x.jpg",     // Tailscale (CGNAT range)
    "https://dantes-laptop.tailb2bea0.ts.net/api/photos/pho_1",
    "http://169.254.10.10/x.jpg",
    "file:///tmp/x.jpg",
    "not a url",
  ]) {
    assert.equal(isPubliclyFetchable(url), false, `${url} is not reachable from Shopify`);
  }
  for (const url of [
    "https://cdn.shopify.com/s/files/1/x.jpg",
    "https://example.com/photo.jpg",
    "http://8.8.8.8/x.jpg",
    "http://100.63.0.1/x.jpg",                // just below the CGNAT range
    "http://172.32.0.1/x.jpg",                // just above the private 172 block
  ]) {
    assert.equal(isPubliclyFetchable(url), true, `${url} is public`);
  }
});

test("the re-hoster only reads this server's own photos", async () => {
  // photo_url can arrive in a request body. Fetching whatever it names and
  // publishing the bytes publicly would hand out a public link to anything
  // this machine can reach.
  const { stageLocalImage } = await import("../services/shopify/shopify-client.js");
  let fetched = 0;
  const spy = async () => { fetched += 1; return new Response("x", { status: 200 }); };
  for (const url of [
    "http://169.254.169.254/latest/meta-data/",
    "http://192.168.1.1/admin",
    "http://localhost:3000/api/health",
    "http://localhost:3000/api/photos/../../.env",
    "file:///etc/passwd",
  ]) {
    await assert.rejects(() => stageLocalImage(url, spy), /refusing to re-host/, url);
  }
  assert.equal(fetched, 0, "nothing was even requested");
});

test("a second product with the same name is retried under its own handle", async () => {
  const inputs = [];
  const fakeFetch = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    if (!/productCreate/.test(query)) return { ok: true, status: 200, json: async () => ({ data: {} }) };
    inputs.push(variables.input);
    const clash = inputs.length === 1;
    return {
      ok: true, status: 200,
      json: async () => ({ data: { productCreate: clash
        ? { product: null, userErrors: [{ field: ["handle"], message: "Handle has already been taken" }] }
        : { product: { id: "gid://shopify/Product/2", handle: variables.input.handle, title: "Apple iPhone", status: "ACTIVE", variants: { nodes: [] } }, userErrors: [] } } }),
    };
  };
  process.env.SHOPIFY_STORE_DOMAIN = "test-store.myshopify.com";
  process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "test-token";
  await createProduct({ title: "Apple iPhone", description: "x", price: 100, customFetch: fakeFetch, dryRun: false });
  assert.equal(inputs.length, 2, "it asked again instead of failing the listing");
  assert.equal(inputs[0].handle, undefined);
  assert.match(inputs[1].handle, /^apple-iphone-[a-z0-9]+$/);
});

test("a connection that never opened is retried; anything after the request went out is not", async () => {
  const { fetchRetryingConnect } = await import("../services/shopify/shopify-client.js");
  const connectFail = () => Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new AggregateError([], ""), { code: "ETIMEDOUT", errors: [{ code: "ETIMEDOUT" }, { code: "EHOSTUNREACH" }] }),
  });
  let calls = 0;
  const flaky = async () => { calls += 1; if (calls < 3) throw connectFail(); return { ok: true }; };
  assert.deepEqual(await fetchRetryingConnect(flaky, "u", {}, { waitMs: 1 }), { ok: true });
  assert.equal(calls, 3);

  // The request reached Shopify and the reply was lost: a second send could
  // create the product twice, so this one is NOT retried.
  calls = 0;
  const midFlight = async () => { calls += 1; throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); };
  await assert.rejects(fetchRetryingConnect(midFlight, "u", {}, { waitMs: 1 }), /fetch failed/);
  assert.equal(calls, 1);

  calls = 0;
  const dead = async () => { calls += 1; throw connectFail(); };
  await assert.rejects(fetchRetryingConnect(dead, "u", {}, { waitMs: 1 }), /fetch failed/);
  assert.equal(calls, 3, "gives up after three");
});
