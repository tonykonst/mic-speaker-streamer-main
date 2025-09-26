const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_TOKENS = 1024;

class ClaudeClient {
  constructor({ apiKey, apiVersion = '2023-06-01', baseUrl = 'https://api.anthropic.com', fetchImpl = global.fetch } = {}) {
    this.apiKey = apiKey;
    this.apiVersion = apiVersion;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
  }

  get isConfigured() {
    return Boolean(this.apiKey);
  }

  async sendMessages({
    model,
    system,
    messages,
    responseFormat,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxTokens,
  }) {
    if (!this.isConfigured) {
      throw new Error('Claude API key is not configured');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resolvedMaxTokens = Number.isInteger(maxTokens) && maxTokens > 0
        ? maxTokens
        : DEFAULT_MAX_TOKENS;

      const body = {
        model,
        system,
        messages,
        max_tokens: resolvedMaxTokens,
      };

      if (responseFormat) {
        body.response_format = responseFormat;
      }

      const response = await this.fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': this.apiVersion,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        throw new Error(`Claude API error ${response.status}: ${errText}`);
      }

      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = {
  ClaudeClient,
};
