class EvaluationPlanService {
  constructor({ claudeClient, logger = console, model = 'claude-3-opus-20240229' } = {}) {
    this.claudeClient = claudeClient;
    this.logger = logger;
    this.model = model;
  }

  get isEnabled() {
    return this.claudeClient?.isConfigured;
  }

  async generatePlan({ jdText, sessionId }) {
    if (!jdText || !jdText.trim()) {
      throw new Error('JD text is required');
    }

    if (!this.isEnabled) {
      throw new Error('Claude API key is not configured');
    }

    const prompt = this._buildPrompt(jdText, sessionId);

    const response = await this.claudeClient.sendMessages(prompt);
    const structured = this._extractJson(response);
    if (!structured?.groups || structured.groups.length === 0) {
      throw new Error('Claude returned no evaluation groups');
    }
    return structured;
  }

  _buildPrompt(jdText, sessionId) {
    return {
      model: this.model,
      system:
        'You are a hiring copilot. Read the job description and output strict JSON with properties sessionId and groups[]. Each group must include id, title, importance (must-have|nice-to-have), criteria array, successSignals, riskSignals, conflictSignals, probingQuestions, successSummary, riskSummary. Return only minified JSON without additional commentary.',
      maxTokens: 1500,
      timeoutMs: 45000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Session: ${sessionId || 'unknown'}\n\nJob Description:\n${jdText}`,
            },
          ],
        },
      ],
    };
  }

  _extractJson(response) {
    if (!response) return null;
    const candidates = Array.isArray(response.content) ? response.content : [];
    const jsonPart = candidates.find((part) => part.type === 'json');
    if (jsonPart?.json) {
      return jsonPart.json;
    }
    const textPart = candidates.find((part) => part.type === 'text');
    if (textPart?.text) {
      try {
        return JSON.parse(textPart.text);
      } catch (_err) {
        return null;
      }
    }
    return null;
  }
}

module.exports = {
  EvaluationPlanService,
};
