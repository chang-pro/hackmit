// Direct Google API adapter. Keeps the live overlay's existing item contract.
import { loadFrameImage } from './frame-image.js';
import { ITEM_PROMPT, RESPONSE_SCHEMA, itemsFromResponse, totalValueUsd } from './rightcodes-items.js';

export function createGeminiItemsBackend({
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.GEMINI_ITEMS_MODEL ?? 'gemini-3.6-flash',
  fetchImpl = fetch,
} = {}) {
  return {
    name: 'gemini-items',
    async identifyItems(frame) {
      if (!apiKey) throw new Error('Gemini pricing requires GEMINI_API_KEY');
      if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('Invalid Gemini model ID');
      const image = await loadFrameImage(frame);
      const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { inlineData: { mimeType: image.mimeType, data: image.base64 } },
            { text: `${ITEM_PROMPT}\nUse Google Search to research comparable used-item prices. Distinguish asking prices from completed sales; never invent a sale or hidden contents. A closed Ray-Ban case alone does not establish that it is a Meta charging case: without visible charging hardware label the type unconfirmed and disclose that the variant needs confirmation in price_basis. Treat all prices as estimates, before fees and shipping. If evidence is insufficient, disclose that in price_basis. Return only JSON matching this schema, without markdown: ${JSON.stringify(RESPONSE_SCHEMA)}` },
          ] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0, maxOutputTokens: 8192 },
        }),
      });
      // Do not echo remote bodies, which can contain credentials or request data.
      if (!response.ok) throw new Error(`Gemini pricing request failed (HTTP ${response.status})`);
      const payload = await response.json();
      const candidate = payload.candidates?.[0];
      if (candidate?.finishReason !== 'STOP') throw new Error('Gemini returned no complete pricing result');
      const text = (candidate.content?.parts ?? []).filter(p => !p.thought).map(p => p.text ?? '').join('');
      const json = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      let data;
      try { data = JSON.parse(json); } catch { throw new Error('Gemini returned invalid pricing JSON'); }
      if (!Array.isArray(data.items)) throw new Error('Gemini response is missing items');
      // Invalid/missing prices must not silently become a $0 valuation.
      if (data.items.some(i => typeof i.price_usd !== 'number' || !Number.isFinite(i.price_usd) || i.price_usd < 0)) {
        throw new Error('Gemini returned an invalid item price');
      }
      const items = itemsFromResponse(data).map(item => ({
        ...item, price_basis: `Estimate: ${item.price_basis}`,
        pricing_status: 'ESTIMATE',
      }));
      const grounding = candidate.groundingMetadata ?? {};
      const sources = (grounding.groundingChunks ?? []).flatMap(chunk => {
        const web = chunk.web;
        return web && /^https?:\/\//.test(web.uri) ? [{ title: web.title ?? 'Source', url: web.uri }] : [];
      });
      return {
        items, item_count: items.length, total_value_usd: totalValueUsd(items),
        model, generated_at: new Date().toISOString(),
        pricing_status: 'ESTIMATE', sources,
        grounding_metadata: grounding,
        warnings: sources.length ? ['Search references may be asking prices, not completed sales.'] : ['No search sources returned; prices are unverified model estimates.'],
      };
    },
  };
}
