import { rightcodesItemsBackend } from './rightcodes-items.js';
import { createGeminiItemsBackend } from './gemini-items.js';

export function selectedItemsBackend() {
  // GEMINI_API_KEY is also what voice confirmation needs, so its presence says
  // nothing about where pricing should go: adding it for voice silently moved
  // pricing off right.codes and onto Google's direct quota, which answered 429.
  // right.codes wins when its key is set; ITEMS_PROVIDER overrides either way.
  const hasRightcodes = Boolean(process.env.RIGHTCODES_KEY_GEMINI ?? process.env.RIGHTCODES_API_KEY);
  const provider = process.env.ITEMS_PROVIDER
    ?? (hasRightcodes ? 'rightcodes' : process.env.GEMINI_API_KEY ? 'gemini' : 'rightcodes');
  if (provider === 'gemini') return createGeminiItemsBackend();
  if (provider === 'rightcodes') return rightcodesItemsBackend;
  throw new Error(`Unknown ITEMS_PROVIDER: ${provider}`);
}
