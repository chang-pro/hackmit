// Zero-dependency Shopify Admin API client.
//
// Uses native Node fetch to interact with the Shopify GraphQL Admin API.
// Requires SHOPIFY_STORE_DOMAIN (e.g. reloop-dev.myshopify.com) and
// SHOPIFY_ADMIN_ACCESS_TOKEN (e.g. shpat_...) in the environment.
//
// In dry-run mode (DRY_RUN=1 or missing token), it logs what would be
// sent and returns a simulated response without making live network calls.

try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile();
  }
} catch {
  // Ignore if .env is missing or already loaded
}

export const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2024-01";

export class ShopifyError extends Error {
  constructor(message, { status = null, errors = null } = {}) {
    super(message);
    this.name = "ShopifyError";
    this.status = status;
    this.errors = errors;
  }
}

let cachedToken = null;
let tokenExpiresAt = 0;

export function getShopifyConfig() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN || "reloop-dev.myshopify.com";
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || null;
  const clientId = process.env.SHOPIFY_CLIENT_ID || process.env.SHOPIFY_API_KEY || null;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || (token?.startsWith("shpss_") ? token : null);
  const isDryRun = process.env.DRY_RUN === "1" || (!token && !clientId);
  return { domain, token, clientId, clientSecret, isDryRun, apiVersion: SHOPIFY_API_VERSION };
}

export async function getOrExchangeAccessToken(customFetch = fetch) {
  const config = getShopifyConfig();
  if (config.isDryRun) return null;

  // Static Admin API PAT (starts with shpat_ or non-secret format)
  if (config.token && !config.token.startsWith("shpss_")) {
    return config.token;
  }

  // Active cached token from previous exchange
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  // Modern App flow: exchange client_id + client_secret for short-lived access token
  if (config.clientId && config.clientSecret) {
    const cleanDomain = config.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const tokenUrl = `https://${cleanDomain}/admin/oauth/access_token`;
    const res = await customFetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new ShopifyError(
        `Failed to exchange client credentials with Shopify (${res.status}): ${text}`,
        { status: res.status }
      );
    }

    const payload = await res.json();
    if (payload?.access_token) {
      cachedToken = payload.access_token;
      tokenExpiresAt = Date.now() + ((payload.expires_in || 86400) - 300) * 1000;
      return cachedToken;
    }
  }

  if (config.token?.startsWith("shpss_") && !config.clientId) {
    throw new ShopifyError(
      `SHOPIFY_ADMIN_ACCESS_TOKEN is an app secret (shpss_...), not an access token. ` +
      `Add SHOPIFY_CLIENT_ID=<your-app-client-id> to .env so ReLoop can automatically exchange it for an access token, ` +
      `or use an Admin API token (shpat_...).`
    );
  }

  return config.token;
}

/**
 * Execute a GraphQL query or mutation against Shopify Admin API.
 */
export async function shopifyGraphql(query, variables = {}, customFetch = fetch) {
  const { domain, isDryRun, apiVersion } = getShopifyConfig();

  if (isDryRun) {
    return {
      dry_run: true,
      query,
      variables,
    };
  }

  const token = await getOrExchangeAccessToken(customFetch);
  const cleanDomain = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const endpoint = `https://${cleanDomain}/admin/api/${apiVersion}/graphql.json`;

  const response = await customFetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new ShopifyError(
      `Shopify Admin API HTTP ${response.status}: ${text}`,
      { status: response.status }
    );
  }


  const json = await response.json();
  if (json.errors && json.errors.length > 0) {
    throw new ShopifyError(
      `Shopify GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`,
      { errors: json.errors }
    );
  }

  return json.data;
}

const PRODUCT_CREATE_MUTATION = `
mutation ProductCreate($input: ProductInput!, $media: [CreateMediaInput!]) {
  productCreate(input: $input, media: $media) {
    product {
      id
      title
      handle
      status
      onlineStoreUrl
      onlineStorePreviewUrl
      variants(first: 1) {
        nodes {
          id
          price
        }
      }
    }
    userErrors {
      field
      message
    }
  }
}
`;

const PRODUCT_VARIANTS_BULK_UPDATE_MUTATION = `
mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants {
      id
      price
    }
    userErrors {
      field
      message
    }
  }
}
`;

const PRODUCT_VARIANT_UPDATE_MUTATION = `
mutation ProductVariantUpdate($input: ProductVariantInput!) {
  productVariantUpdate(input: $input) {
    productVariant {
      id
      price
    }
    userErrors {
      field
      message
    }
  }
}
`;

const PUBLISHABLE_PUBLISH_MUTATION = `
mutation PublishablePublish($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) {
    userErrors { field message }
  }
}
`;

const PRODUCT_URL_QUERY = `
query ProductUrl($id: ID!) {
  product(id: $id) {
    onlineStoreUrl
    onlineStorePreviewUrl
  }
}
`;

/**
 * Publishes a product to the store's sales channels. A product created through
 * the Admin API is NOT on the Online Store until this runs, which is why its
 * storefront URL 404s and `onlineStoreUrl` comes back null.
 *
 * Returns { published, channels, error } and never throws: a product that
 * exists but is not visible is still worth reporting, and the caller decides
 * what to say about it. The failure is always surfaced -- swallowing it is how
 * you get a "live" listing whose link is dead with nothing explaining why.
 *
 * GraphQL needs `write_publications`; the REST fallback needs only
 * `write_products`, so it covers a token issued before that scope was added.
 */
export async function publishToSalesChannels(productGid, customFetch = fetch) {
  const { domain, apiVersion } = getShopifyConfig();
  const cleanDomain = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const numId = String(productGid).split("/").pop();
  const problems = [];

  try {
    const data = await shopifyGraphql(`query { publications(first: 25) { nodes { id name } } }`, {}, customFetch);
    const nodes = data?.publications?.nodes ?? [];
    if (nodes.length === 0) problems.push("no sales channels returned by publications query");
    else {
      const result = await shopifyGraphql(
        PUBLISHABLE_PUBLISH_MUTATION,
        { id: productGid, input: nodes.map((p) => ({ publicationId: p.id })) },
        customFetch
      );
      const userErrors = result?.publishablePublish?.userErrors ?? [];
      if (userErrors.length === 0) {
        return { published: true, channels: nodes.map((p) => p.name), error: null };
      }
      problems.push(userErrors.map((e) => e.message).join("; "));
    }
  } catch (err) {
    problems.push(`publications: ${err.message}`);
  }

  // Fallback: the REST product update marks it published to the Online Store
  // without the publications scope.
  try {
    const token = await getOrExchangeAccessToken(customFetch);
    const res = await customFetch(`https://${cleanDomain}/admin/api/${apiVersion}/products/${numId}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ product: { id: Number(numId), published: true } }),
    });
    if (res.ok) return { published: true, channels: ["Online Store (REST)"], error: null };
    problems.push(`REST publish ${res.status}: ${(await res.text()).slice(0, 200)}`);
  } catch (err) {
    problems.push(`REST publish: ${err.message}`);
  }

  const error = problems.join(" | ");
  console.warn(`Shopify: product ${numId} created but NOT published to a sales channel — ${error}`);
  return { published: false, channels: [], error };
}

/**
 * Creates a new product listing in the Shopify store.
 *
 * @param {Object} params
 * @param {string} params.title
 * @param {string} params.descriptionHtml
 * @param {number|string} params.price
 * @param {string[]} [params.tags]
 * @param {"ACTIVE"|"DRAFT"|"ARCHIVED"} [params.status="ACTIVE"]
 * @param {string} [params.imageUrl]
 * @param {Function} [params.customFetch]
 */
export async function createProduct({
  title,
  descriptionHtml,
  price,
  tags = ["reloop"],
  status = "ACTIVE",
  imageUrl = null,
  customFetch = fetch,
}) {
  const { domain, isDryRun } = getShopifyConfig();
  const cleanDomain = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");

  const productInput = {
    title,
    descriptionHtml,
    tags,
    status,
  };

  const media = imageUrl
    ? [
        {
          originalSource: imageUrl,
          mediaContentType: "IMAGE",
        },
      ]
    : undefined;

  if (isDryRun) {
    const mockId = `gid://shopify/Product/${Math.floor(1000000000 + Math.random() * 9000000000)}`;
    const handle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return {
      dry_run: true,
      product: {
        id: mockId,
        title,
        handle,
        status,
        price: Number(price).toFixed(2),
        url: `https://${cleanDomain}/products/${handle}`,
        adminUrl: `https://${cleanDomain}/admin/products/${mockId.split("/").pop()}`,
      },
    };
  }

  const data = await shopifyGraphql(
    PRODUCT_CREATE_MUTATION,
    { input: productInput, media },
    customFetch
  );

  const payload = data?.productCreate;
  if (payload?.userErrors && payload.userErrors.length > 0) {
    throw new ShopifyError(
      `Shopify product creation failed: ${payload.userErrors.map((e) => `${e.field}: ${e.message}`).join("; ")}`,
      { errors: payload.userErrors }
    );
  }

  const prod = payload?.product;
  const numId = prod.id.split("/").pop();
  const formattedPrice = Number(price).toFixed(2);
  const variantId = prod?.variants?.nodes?.[0]?.id;

  if (variantId && price !== undefined && price !== null) {
    try {
      const updateData = await shopifyGraphql(
        PRODUCT_VARIANTS_BULK_UPDATE_MUTATION,
        {
          productId: prod.id,
          variants: [{ id: variantId, price: formattedPrice }],
        },
        customFetch
      );
      if (updateData?.productVariantsBulkUpdate?.userErrors?.length) {
        await shopifyGraphql(
          PRODUCT_VARIANT_UPDATE_MUTATION,
          { input: { id: variantId, price: formattedPrice } },
          customFetch
        );
      }
    } catch {
      try {
        await shopifyGraphql(
          PRODUCT_VARIANT_UPDATE_MUTATION,
          { input: { id: variantId, price: formattedPrice } },
          customFetch
        );
      } catch (err) {
        console.warn("Could not set variant price:", err.message);
      }
    }
  }

  // Ask Shopify where the product actually is rather than guessing from the
  // handle: onlineStoreUrl is null until the product is published to the
  // Online Store channel, and a guessed URL 404s in exactly that case. The
  // preview URL works before publication, so it is the honest fallback.
  // A product created through the Admin API is not on any sales channel yet.
  const publication = await publishToSalesChannels(prod.id, customFetch);

  // Ask Shopify where the product ended up rather than guessing from the
  // handle: onlineStoreUrl is only non-null once it really is on the Online
  // Store, so it doubles as proof that publishing worked. The create response
  // predates publishing, hence the re-query.
  let onlineStoreUrl = prod.onlineStoreUrl ?? null;
  let previewUrl = prod.onlineStorePreviewUrl ?? null;
  if (publication.published) {
    try {
      const fresh = await shopifyGraphql(PRODUCT_URL_QUERY, { id: prod.id }, customFetch);
      onlineStoreUrl = fresh?.product?.onlineStoreUrl ?? onlineStoreUrl;
      previewUrl = fresh?.product?.onlineStorePreviewUrl ?? previewUrl;
    } catch (err) {
      console.warn(`Shopify: could not read back the product URL: ${err.message}`);
    }
  }
  const productUrl = onlineStoreUrl || previewUrl || `https://${cleanDomain}/products/${prod.handle}`;

  return {
    dry_run: false,
    product: {
      id: prod.id,
      title: prod.title,
      handle: prod.handle,
      status: prod.status,
      price: formattedPrice,
      url: productUrl,
      previewUrl,
      // True when the product is actually reachable on the storefront.
      //
      // onlineStoreUrl alone is NOT a reliable signal: reading it needs the
      // read_publications scope, which this app is not granted, so it comes
      // back null even for products that are live and purchasable. Verified by
      // hand — a product reporting null here was browsable, added to a cart,
      // had its quantity changed and reached checkout. Trusting it alone
      // reported every successful publish as a failure.
      //
      // So a confirmed publish to the Online Store channel counts too.
      publishedToOnlineStore:
        Boolean(onlineStoreUrl) ||
        publication.channels.some((c) => /online store/i.test(c)),
      publishedChannels: publication.channels,
      publishError: publication.error,
      adminUrl: `https://${cleanDomain}/admin/products/${numId}`,
    },
  };
}

