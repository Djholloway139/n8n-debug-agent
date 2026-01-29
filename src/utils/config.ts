import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

export interface Config {
  port: number;
  nodeEnv: string;
  logLevel: string;
  anthropicApiKey: string;
  n8nApiUrl: string;
  n8nApiKey: string;
  slackBotToken: string;
  slackSigningSecret: string;
  slackChannelId: string;
  skillsCacheTtl: number;
  apiBearerToken: string;
}

const REQUIRED_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'N8N_API_URL',
  'N8N_API_KEY',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_CHANNEL_ID',
  'API_BEARER_TOKEN',
] as const;

function validateEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error('\n❌ Missing required environment variables:\n');
    missing.forEach((name) => console.error(`   - ${name}`));
    console.error('\n💡 Copy .env.example to .env and fill in your credentials:\n');
    console.error('   cp .env.example .env\n');
    process.exit(1);
  }
}

function requireEnv(name: string): string {
  return process.env[name]!;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

export function loadConfig(): Config {
  validateEnv();

  return {
    port: parseInt(optionalEnv('PORT', '3000'), 10),
    nodeEnv: optionalEnv('NODE_ENV', 'development'),
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
    anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),
    n8nApiUrl: requireEnv('N8N_API_URL'),
    n8nApiKey: requireEnv('N8N_API_KEY'),
    slackBotToken: requireEnv('SLACK_BOT_TOKEN'),
    slackSigningSecret: requireEnv('SLACK_SIGNING_SECRET'),
    slackChannelId: requireEnv('SLACK_CHANNEL_ID'),
    skillsCacheTtl: parseInt(optionalEnv('SKILLS_CACHE_TTL', '3600000'), 10),
    apiBearerToken: requireEnv('API_BEARER_TOKEN'),
  };
}

export const config = loadConfig();
