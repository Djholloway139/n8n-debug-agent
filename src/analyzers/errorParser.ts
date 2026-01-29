import { logger } from '../utils/logger.js';
import type { ErrorPayload, WorkflowData } from '../types/index.js';

export interface ParsedError {
  category: ErrorCategory;
  nodeType?: string;
  nodeName?: string;
  affectedAreas: string[];
  keywords: string[];
  severity: 'critical' | 'error' | 'warning';
}

export type ErrorCategory =
  | 'authentication'
  | 'network'
  | 'validation'
  | 'configuration'
  | 'rate_limit'
  | 'data_format'
  | 'missing_data'
  | 'timeout'
  | 'permission'
  | 'unknown';

const ERROR_PATTERNS: Record<ErrorCategory, RegExp[]> = {
  authentication: [
    /authentication failed/i,
    /unauthorized/i,
    /invalid.*credentials/i,
    /401/,
    /access.*denied/i,
    /invalid.*token/i,
    /expired.*token/i,
  ],
  network: [
    /ECONNREFUSED/,
    /ENOTFOUND/,
    /ETIMEDOUT/,
    /network.*error/i,
    /connection.*failed/i,
    /socket.*error/i,
    /dns.*error/i,
  ],
  validation: [
    /validation.*failed/i,
    /invalid.*input/i,
    /required.*field/i,
    /schema.*error/i,
    /type.*error/i,
    /invalid.*format/i,
  ],
  configuration: [
    /configuration.*error/i,
    /missing.*configuration/i,
    /invalid.*setting/i,
    /not.*configured/i,
    /parameter.*missing/i,
  ],
  rate_limit: [
    /rate.*limit/i,
    /too.*many.*requests/i,
    /429/,
    /throttl/i,
    /quota.*exceeded/i,
  ],
  data_format: [
    /json.*parse/i,
    /unexpected.*token/i,
    /invalid.*json/i,
    /xml.*parse/i,
    /malformed/i,
  ],
  missing_data: [
    /undefined/i,
    /null/i,
    /not.*found/i,
    /404/,
    /does.*not.*exist/i,
    /no.*data/i,
    /empty.*response/i,
  ],
  timeout: [
    /timeout/i,
    /timed.*out/i,
    /deadline.*exceeded/i,
    /operation.*took.*too.*long/i,
  ],
  permission: [
    /permission.*denied/i,
    /forbidden/i,
    /403/,
    /not.*allowed/i,
    /insufficient.*permissions/i,
  ],
  unknown: [],
};

export function parseError(payload: ErrorPayload, workflow?: WorkflowData): ParsedError {
  const errorMessage = payload.errorMessage || '';
  const errorStack = payload.errorStack || '';
  const fullText = `${errorMessage} ${errorStack}`;

  // Determine category
  let category: ErrorCategory = 'unknown';
  for (const [cat, patterns] of Object.entries(ERROR_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(fullText)) {
        category = cat as ErrorCategory;
        break;
      }
    }
    if (category !== 'unknown') break;
  }

  // Extract node information
  let nodeType = payload.nodeType;
  let nodeName = payload.nodeName;

  // Try to extract from error message if not provided
  if (!nodeName) {
    const nodeMatch = fullText.match(/node\s+['"]?(\w+)['"]?/i);
    if (nodeMatch) {
      nodeName = nodeMatch[1];
    }
  }

  // Find node in workflow if we have the name
  if (workflow && nodeName && !nodeType) {
    const node = workflow.nodes.find((n) => n.name === nodeName);
    if (node) {
      nodeType = node.type;
    }
  }

  // Identify affected areas
  const affectedAreas: string[] = [];

  if (nodeType) {
    affectedAreas.push(`node:${nodeType}`);
  }

  if (category === 'authentication') {
    affectedAreas.push('credentials');
  }

  if (category === 'network' || category === 'timeout') {
    affectedAreas.push('external_service');
  }

  if (category === 'validation' || category === 'data_format') {
    affectedAreas.push('input_data');
  }

  // Extract keywords for skill matching
  const keywords = extractKeywords(fullText);

  // Determine severity
  let severity: ParsedError['severity'] = 'error';
  if (category === 'authentication' || category === 'permission') {
    severity = 'critical';
  } else if (category === 'rate_limit' || category === 'timeout') {
    severity = 'warning';
  }

  logger.debug('Parsed error', {
    category,
    nodeType,
    nodeName,
    affectedAreas,
    severity,
    keywordCount: keywords.length,
  });

  return {
    category,
    nodeType,
    nodeName,
    affectedAreas,
    keywords,
    severity,
  };
}

function extractKeywords(text: string): string[] {
  // Remove common stop words and extract meaningful keywords
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'was', 'are', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
    'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
    'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above',
    'below', 'between', 'under', 'again', 'further', 'then', 'once',
    'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few',
    'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
    'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but',
    'if', 'or', 'because', 'until', 'while', 'this', 'that', 'these',
    'those', 'error', 'failed', 'failure',
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !stopWords.has(word));

  // Get unique words
  const unique = [...new Set(words)];

  // Return top keywords
  return unique.slice(0, 20);
}

export function getErrorContext(payload: ErrorPayload): string {
  const parts: string[] = [];

  if (payload.nodeName) {
    parts.push(`Node: ${payload.nodeName}`);
  }

  if (payload.nodeType) {
    parts.push(`Type: ${payload.nodeType}`);
  }

  parts.push(`Error: ${payload.errorMessage.slice(0, 100)}`);

  return parts.join(' | ');
}
