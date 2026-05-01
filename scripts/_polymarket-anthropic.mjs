/**
 * Anthropic Messages API — 供 seed enrichment 与 polymarket-module4-validate 共用。
 */

/**
 * @param {object} [options]
 * @param {string} [options.apiKey]
 * @param {string} [options.model]
 * @param {number} [options.maxTokens]
 * @returns {Promise<(opts: { system: string, user: string }) => Promise<string>>}
 */
export async function createAnthropicCallLlm(options = {}) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required for LLM calls');
  }
  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-3-5-haiku-20241022';
  const maxTokens = Number(options.maxTokens ?? 1200);
  const client = new Anthropic({ apiKey });

  return async ({ system, user }) => {
    const msg = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const block = msg.content?.[0];
    if (block && block.type === 'text') return block.text;
    return '';
  };
}
