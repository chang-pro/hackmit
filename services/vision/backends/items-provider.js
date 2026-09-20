import { rightcodesItemsBackend } from './rightcodes-items.js';
import { createGeminiItemsBackend } from './gemini-items.js';

// If the first provider fails, the second gets the same frame. One provider
// having a bad minute used to blank the live view for the whole demo.
export function withFallback(primary, secondary) {
  return {
    name: `${primary.name}+${secondary.name}`,
    async identifyItems(frame) {
      try {
        return await primary.identifyItems(frame);
      } catch (first) {
        try {
          return await secondary.identifyItems(frame);
        } catch {
          throw first; // the primary's error is the one worth reading
        }
      }
    },
  };
}

export function selectedItemsBackend() {
  // GEMINI_API_KEY is also what voice confirmation needs, so its presence says
  // nothing about where pricing should go: adding it for voice silently moved
  // pricing off right.codes and onto Google's direct quota, which answered 429.
  // right.codes wins when its key is set; ITEMS_PROVIDER overrides either way.
  const hasRightcodes = Boolean(process.env.RIGHTCODES_KEY_GEMINI ?? process.env.RIGHTCODES_API_KEY);
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  const provider = process.env.ITEMS_PROVIDER
    ?? (hasRightcodes ? 'rightcodes' : hasGemini ? 'gemini' : 'rightcodes');
  if (provider === 'gemini') return hasRightcodes ? withFallback(createGeminiItemsBackend(), rightcodesItemsBackend) : createGeminiItemsBackend();
  if (provider === 'rightcodes') return hasGemini ? withFallback(rightcodesItemsBackend, createGeminiItemsBackend()) : rightcodesItemsBackend;
  throw new Error(`Unknown ITEMS_PROVIDER: ${provider}`);
}
