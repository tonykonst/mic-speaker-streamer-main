const path = require('node:path');

function boolFromEnv(value) {
  if (!value) return false;
  const normalized = value.toString().trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

const appConfig = {
  useClaudeCoach: boolFromEnv(process.env.JD_COACH_V2),
  claudeApiKey: (process.env.CLAUDE_API_KEY || '').trim() || null,
  claudeModel: process.env.CLAUDE_MODEL?.trim() || 'claude-3-opus-20240229',
  claudeApiVersion: process.env.CLAUDE_API_VERSION?.trim() || '2023-06-01',
  dataRoot: path.resolve('./JobData'),
};

module.exports = appConfig;
