import { rightcodesItemsBackend } from './rightcodes-items.js';
import { createGeminiItemsBackend } from './gemini-items.js';

export function selectedItemsBackend() {
  const provider = process.env.ITEMS_PROVIDER ?? (process.env.GEMINI_API_KEY ? 'gemini' : 'rightcodes');
  if (provider === 'gemini') return createGeminiItemsBackend();
  if (provider === 'rightcodes') return rightcodesItemsBackend;
  throw new Error(`Unknown ITEMS_PROVIDER: ${provider}`);
}
