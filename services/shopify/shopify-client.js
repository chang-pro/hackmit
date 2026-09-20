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
    const res = await fetchRetryingConnect(customFetch, tokenUrl, {
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
// Failures where the connection never opened, so Shopify never saw the request
// and sending it again cannot create a second product. A timeout AFTER the
// request went out is not in this list on purpose.
const NEVER_CONNECTED = new Set(["ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);

function neverConnected(err) {
  const causes = [err?.cause, ...(err?.cause?.errors ?? [])].filter(Boolean);
  return causes.length > 0 && causes.every((c) => NEVER_CONNECTED.has(c.code));
}

// One flaky connect on venue wifi failed the whole listing. Try again, briefly.
export async function fetchRetryingConnect(fetchImpl, url, init, { tries = 3, waitMs = 400 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetchImpl(url, init);
    } catch (err) {
      if (attempt >= tries || !neverConnected(err)) throw err;
      await new Promise((done) => setTimeout(done, waitMs * attempt));
    }
  }
}

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

  const response = await fetchRetryingConnect(customFetch, endpoint, {
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
// Shopify attaches an image by fetching its URL from Shopify's own servers, so
// an address only this machine or this tailnet can reach never loads: the
// product is created and its photo silently fails to attach.
export function isPubliclyFetchable(url) {
  let host;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".ts.net")) return false;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!v4) return !host.includes(":"); // a bare IPv6 literal is not worth guessing at
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT range, which is where Tailscale lives
  return true;
}

const STAGED_UPLOAD_MUTATION = `
mutation StagedUpload($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

// For a photo Shopify cannot reach: read the bytes here, push them to Shopify's
// staged-upload storage, and hand back the URL Shopify gave us for them.
export async function stageLocalImage(imageUrl, customFetch = fetch) {
  // photo_url can arrive in a request body. Fetching whatever it names and
  // publishing the bytes to a public bucket would let a caller read anything
  // this machine can reach (a router page, a cloud metadata address) and get a
  // public link to it. Only our own stored photos are ever re-hosted.
  let path;
  try { path = new URL(imageUrl).pathname; } catch { path = ""; }
  if (!/^\/api\/photos\/(pho|demo)_[A-Za-z0-9_-]{1,64}$/.test(path)) {
    throw new ShopifyError(`refusing to re-host ${imageUrl}: not one of this server's photos`);
  }
  const local = await customFetch(imageUrl);
  if (!local.ok) throw new ShopifyError(`could not read the photo at ${imageUrl} (${local.status})`);
  const mime = (local.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
  const bytes = await local.arrayBuffer();
  const filename = `reloop-${Date.now()}.${mime === "image/png" ? "png" : "jpg"}`;

  const staged = await shopifyGraphql(
    STAGED_UPLOAD_MUTATION,
    { input: [{ resource: "IMAGE", filename, mimeType: mime, httpMethod: "POST" }] },
    customFetch
  );
  const result = staged?.stagedUploadsCreate ?? staged?.data?.stagedUploadsCreate;
  const target = result?.stagedTargets?.[0];
  if (!target?.url || !target?.resourceUrl) {
    const why = (result?.userErrors ?? []).map((e) => e.message).join("; ") || "no upload target returned";
    throw new ShopifyError(`Shopify would not stage the photo: ${why}`);
  }

  // The signed fields first and the file LAST: the storage backend rejects a
  // form where the file precedes its policy fields.
  const form = new FormData();
  for (const { name, value } of target.parameters) form.append(name, value);
  form.append("file", new Blob([bytes], { type: mime }), filename);
  const uploaded = await customFetch(target.url, { method: "POST", body: form });
  if (!uploaded.ok) throw new ShopifyError(`staged photo upload failed (${uploaded.status})`);
  return target.resourceUrl;
}

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

  let imageSource = imageUrl || null;
  let imageError = null;
  if (imageSource && !isDryRun && !isPubliclyFetchable(imageSource)) {
    try {
      imageSource = await stageLocalImage(imageSource, customFetch);
    } catch (err) {
      // A listing without its photo beats no listing. The reason is reported.
      imageError = err.message;
      imageSource = null;
    }
  }

  const media = imageSource
    ? [
        {
          originalSource: imageSource,
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

  let data = await shopifyGraphql(
    PRODUCT_CREATE_MUTATION,
    { input: productInput, media },
    customFetch
  );

  // Two items with the same name ("Apple iPhone" twice in one room) are created
  // moments apart, and Shopify hands both the same generated handle: the second
  // fails with "Handle has already been taken". Ask again with a handle nobody
  // else can have.
  if ((data?.productCreate?.userErrors ?? []).some((e) => /handle/i.test(`${e.field} ${e.message}`))) {
    const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
    const unique = `${slug}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    data = await shopifyGraphql(
      PRODUCT_CREATE_MUTATION,
      { input: { ...productInput, handle: unique }, media },
      customFetch
    );
  }

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
      imageAttached: Boolean(media),
      imageError,
      publishError: publication.error,
      adminUrl: `https://${cleanDomain}/admin/products/${numId}`,
    },
  };
}

// A URL anyone on the internet can fetch, for a photo that currently lives on
// this machine. muse.ai downloads Marketplace photos on ITS OWN VM — verified:
// localhost is refused and the tailnet address is unreachable from there — so a
// local path means a listing with no picture. Shopify's staged-upload bucket is
// already available to us and serves the file publicly, so it doubles as
// hosting. Returns the original URL when it is already public, and null when it
// cannot be hosted, so callers can carry on without a photo.
export async function publicPhotoUrl(imageUrl, customFetch = fetch) {
  if (!imageUrl) return null;
  if (isPubliclyFetchable(imageUrl)) return imageUrl;
  const { isDryRun } = getShopifyConfig();
  if (isDryRun) return null;
  try {
    return await stageLocalImage(imageUrl, customFetch);
  } catch {
    return null;
  }
}
