"""
Zero-dependency Python Shopify Admin API client for ReLoop.

Publishes approved items to Shopify via GraphQL Admin API.
Supports dry-run mode when SHOPIFY_ADMIN_ACCESS_TOKEN is not configured.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


def _load_env_file() -> None:
    env_path = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
    if os.path.exists(env_path):
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, val = line.partition("=")
                    key = key.strip()
                    val = val.strip().strip('"').strip("'")
                    if key and key not in os.environ:
                        os.environ[key] = val
        except Exception:
            pass


_load_env_file()

SHOPIFY_API_VERSION = os.getenv("SHOPIFY_API_VERSION", "2024-01")


class ShopifyError(Exception):
    def __init__(self, message: str, status: int | None = None, errors: list[Any] | None = None):
        super().__init__(message)
        self.status = status
        self.errors = errors


_cached_token: str | None = None


def get_shopify_config() -> dict[str, Any]:
    domain = os.getenv("SHOPIFY_STORE_DOMAIN", "reloop-dev.myshopify.com")
    token = os.getenv("SHOPIFY_ADMIN_ACCESS_TOKEN")
    client_id = os.getenv("SHOPIFY_CLIENT_ID") or os.getenv("SHOPIFY_API_KEY")
    client_secret = os.getenv("SHOPIFY_CLIENT_SECRET") or (
        token if token and token.startswith("shpss_") else None)
    is_dry_run = os.getenv("DRY_RUN") == "1" or (not token and not client_id)
    return {
        "domain": domain.strip().replace("https://", "").replace("http://", "").rstrip("/"),
        "token": token,
        "client_id": client_id,
        "client_secret": client_secret,
        "is_dry_run": is_dry_run,
        "api_version": SHOPIFY_API_VERSION,
    }


def get_or_exchange_access_token() -> str | None:
    global _cached_token
    config = get_shopify_config()
    if config["is_dry_run"]:
        return None
    token = config["token"]
    if token and not token.startswith("shpss_"):
        return token
    if _cached_token:
        return _cached_token

    if config["client_id"] and config["client_secret"]:
        url = f"https://{config['domain']}/admin/oauth/access_token"
        data = urllib.parse.urlencode({
            "grant_type": "client_credentials",
            "client_id": config["client_id"],
            "client_secret": config["client_secret"],
        }).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers={
                                     "Content-Type": "application/x-www-form-urlencoded"}, method="POST")
        try:
            with urllib.request.urlopen(req) as resp:
                res_data = json.loads(resp.read().decode("utf-8"))
                if "access_token" in res_data:
                    _cached_token = res_data["access_token"]
                    return _cached_token
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8")
            raise ShopifyError(
                f"Failed to exchange client credentials with Shopify ({e.code}): {body}", status=e.code) from e

    if token and token.startswith("shpss_") and not config["client_id"]:
        raise ShopifyError(
            "SHOPIFY_ADMIN_ACCESS_TOKEN is an app secret (shpss_...), not an access token. "
            "Add SHOPIFY_CLIENT_ID=<your-app-client-id> to .env so ReLoop can automatically exchange it for an access token, "
            "or use an Admin API token (shpat_...)."
        )
    return token


def execute_graphql(query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
    config = get_shopify_config()
    if config["is_dry_run"]:
        return {"dry_run": True, "query": query, "variables": variables}

    token = get_or_exchange_access_token()
    url = f"https://{config['domain']}/admin/api/{config['api_version']}/graphql.json"
    payload = json.dumps(
        {"query": query, "variables": variables or {}}).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
    }

    req = urllib.request.Request(
        url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        raise ShopifyError(
            f"Shopify Admin API HTTP {e.code}: {body}", status=e.code) from e

    if "errors" in data and data["errors"]:
        msg = "; ".join(err.get("message", "") for err in data["errors"])
        raise ShopifyError(
            f"Shopify GraphQL error: {msg}", errors=data["errors"])

    return data.get("data", {})


PRODUCT_CREATE_MUTATION = """
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
"""


def create_shopify_listing(
    title: str,
    price: float | int,
    description_html: str = "",
    condition: str = "Good",
    tags: list[str] | None = None,
    status: str = "ACTIVE",
    image_url: str | None = None,
) -> dict[str, Any]:
    """
    Creates a product in Shopify and returns product metadata and links.
    """
    config = get_shopify_config()
    domain = config["domain"]

    product_tags = ["reloop", f"condition:{condition.lower()}"]
    if tags:
        product_tags.extend(tags)

    if not description_html:
        description_html = (
            f"<div><p><strong>Item:</strong> {title}</p>"
            f"<p><strong>Condition:</strong> {condition}</p>"
            f"<p><em>Identified and priced by ReLoop visual intelligence.</em></p></div>"
        )

    product_input = {
        "title": title,
        "descriptionHtml": description_html,
        "tags": product_tags,
        "status": status,
        "variants": [{"price": f"{float(price):.2f}"}],
    }

    media = None
    if image_url:
        media = [{"originalSource": image_url, "mediaContentType": "IMAGE"}]

    if config["is_dry_run"]:
        clean_handle = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
        mock_id = "gid://shopify/Product/7609008478"
        return {
            "dry_run": True,
            "product": {
                "id": mock_id,
                "title": title,
                "handle": clean_handle,
                "status": status,
                "price": f"{float(price):.2f}",
                "url": f"https://{domain}/products/{clean_handle}",
                "adminUrl": f"https://{domain}/admin/products/{mock_id.split('/')[-1]}",
            },
        }

    data = execute_graphql(PRODUCT_CREATE_MUTATION, {
                           "input": product_input, "media": media})
    payload = data.get("productCreate", {})
    user_errors = payload.get("userErrors", [])
    if user_errors:
        err_msg = "; ".join(
            f"{e.get('field')}: {e.get('message')}" for e in user_errors)
        raise ShopifyError(
            f"Shopify product creation failed: {err_msg}", errors=user_errors)

    prod = payload.get("product", {})
    prod_id = prod.get("id", "")
    num_id = prod_id.split("/")[-1]
    handle = prod.get("handle", "")

    return {
        "dry_run": False,
        "product": {
            "id": prod_id,
            "title": prod.get("title", title),
            "handle": handle,
            "status": prod.get("status", status),
            "price": f"{float(price):.2f}",
            "url": f"https://{domain}/products/{handle}",
            "adminUrl": f"https://{domain}/admin/products/{num_id}",
        },
    }
