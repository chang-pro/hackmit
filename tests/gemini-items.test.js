import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiItemsBackend } from '../services/vision/backends/gemini-items.js';
const frame = { image_base64: 'abc', mime_type: 'image/jpeg' };
const item = { label: 'Case', condition: 'good', price_usd: 10, bbox: { x: 1, y: 2, width: 100, height: 200 }, confidence: .8 };
function backend(data, metadata = {}) {
  return createGeminiItemsBackend({ apiKey: 'test-key', fetchImpl: async (url, request) => {
    assert.match(url, /^https:\/\/generativelanguage.googleapis.com\//);
    assert.equal(request.headers['x-goog-api-key'], 'test-key');
    assert.deepEqual(JSON.parse(request.body).tools, [{ google_search: {} }]);
    return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(data) }] }, groundingMetadata: metadata }] }) };
  } });
}
test('preserves overlay contract and real grounding sources', async () => {
  const result = await backend({ items: [item] }, { groundingChunks: [{ web: { uri: 'https://example.com/item', title: 'Listing' } }] }).identifyItems(frame);
  assert.equal(result.total_value_usd, 10);
  assert.equal(result.items[0].pricing_status, 'ESTIMATE');
  assert.equal(result.sources[0].url, 'https://example.com/item');
});
test('no sources is explicitly unverified', async () => {
  const result = await backend({ items: [item] }).identifyItems(frame);
  assert.match(result.warnings[0], /unverified/);
});
test('missing prices and malformed payloads fail instead of returning zero', async () => {
  await assert.rejects(backend({ items: [{ ...item, price_usd: null }] }).identifyItems(frame), /invalid item price/);
  await assert.rejects(backend({}).identifyItems(frame), /missing items/);
});
test('HTTP errors do not expose provider response or key', async () => {
  const b = createGeminiItemsBackend({ apiKey: 'secret', fetchImpl: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(b.identifyItems(frame), { message: 'Gemini pricing request failed (HTTP 403)' });
});
