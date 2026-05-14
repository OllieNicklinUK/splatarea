/**
 * AIService.js — provider factory
 *
 * Reads AI_PROVIDER from env and exports the correct service singleton.
 * To switch backends, change AI_PROVIDER in .env and restart the server:
 *
 *   AI_PROVIDER=gemini   → uses GeminiService
 *   AI_PROVIDER=openai   → uses OpenAIService  (requires OPENAI_API_KEY)
 */

// Ensure .env is loaded before reading AI_PROVIDER (ESM static imports run before
// dotenv/config in index.js, so we load it explicitly here as a safety net).
import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const _dir = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(_dir, '..', '..', '.env') });

const provider = (process.env.AI_PROVIDER || 'gemini').toLowerCase().trim();

let aiService;

if (provider === 'openai') {
    const { default: OpenAIService } = await import('./OpenAIService.js');
    aiService = OpenAIService;
} else {
    // Default: gemini
    const { default: GeminiService } = await import('./GeminiService.js');
    aiService = GeminiService;
}

export default aiService;
