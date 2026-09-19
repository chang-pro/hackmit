// Zero-dependency Shopify Admin API client.
//
// Uses native Node fetch to interact with the Shopify GraphQL Admin API.
// Requires SHOPIFY_STORE_DOMAIN (e.g. reloop-dev.myshopify.com) and
// SHOPIFY_ADMIN_ACCESS_TOKEN (e.g. shpat_...) in the environment.
//
// In dry-run mode (DRY_RUN=1 or missing token), it logs what would be
// sent and returns a simulated response without making live network calls.

export const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2024-01";

export class ShopifyError extends Error {
  constructor(message, { status = null, errors = null } = {}) {
    super(message);
    this.name = "ShopifyError";
    this.status = status;
    this.errors = errors;
  }
}

export function getShopifyConfig() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN || "reloop-dev.myshopify.com";
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || null;
  const isDryRun = process.env.DRY_RUN === "1" || !token;
  return { domain, token, isDryRun, apiVersion: SHOPIFY_API_VERSION };
}

/**
 * Execute a GraphQL query or mutation against Shopify Admin API.
 */
export async function shopifyGraphql(query, variables = {}, customFetch = fetch) {
  const { domain, token, isDryRun, apiVersion } = getShopifyConfig();

  if (isDryRun) {
    return {
      dry_run: true,
      query,
      variables,
    };
  }

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
    variants: [
      {
        price: Number(price).toFixed(2),
      },
    ],
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
  return {
    dry_run: false,
    product: {
      id: prod.id,
      title: prod.title,
      handle: prod.handle,
      status: prod.status,
      price: prod.variants?.nodes?.[0]?.price ?? Number(price).toFixed(2),
      url: `https://${cleanDomain}/products/${prod.handle}`,
      adminUrl: `https://${cleanDomain}/admin/products/${numId}`,
    },
  };
}

