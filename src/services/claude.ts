import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type {
  ErrorPayload,
  ErrorAnalysis,
  WorkflowData,
  WorkflowChange,
  N8nSkill,
} from '../types/index.js';

const SYSTEM_PROMPT = `You are an expert n8n workflow debugging assistant. Your role is to analyze workflow errors and propose fixes.

When analyzing errors, you should:
1. Identify the root cause of the error
2. Consider the workflow structure and node configurations
3. Reference relevant n8n documentation and best practices
4. Propose specific, actionable fixes

Your responses must be in valid JSON format matching the required schema.

Important guidelines:
- Be specific about which node(s) need changes
- Provide clear explanations that non-technical users can understand
- Consider edge cases and potential side effects of proposed fixes
- If unsure, indicate lower confidence and suggest manual review
- Never propose changes that could expose credentials or sensitive data`;

interface AnalysisContext {
  errorPayload: ErrorPayload;
  workflow: WorkflowData;
  skills: N8nSkill[];
  nodeDocumentation?: string;
}

interface ClaudeAnalysisResponse {
  rootCause: string;
  explanation: string;
  affectedNodes: string[];
  suggestedFix: {
    description: string;
    changes: WorkflowChange[];
    rollbackPossible: boolean;
  };
  confidence: 'high' | 'medium' | 'low';
  relatedSkills: string[];
}

export class ClaudeClient {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({
      apiKey: config.anthropicApiKey,
    });
  }

  async analyzeError(context: AnalysisContext): Promise<ErrorAnalysis> {
    logger.info('Analyzing error with Claude', {
      workflowId: context.workflow.id,
      nodeName: context.errorPayload.nodeName,
    });

    const userPrompt = this.buildPrompt(context);

    try {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: userPrompt,
          },
        ],
        tools: [
          {
            name: 'provide_analysis',
            description: 'Provide the error analysis and fix proposal',
            input_schema: {
              type: 'object',
              properties: {
                rootCause: {
                  type: 'string',
                  description: 'Technical root cause of the error',
                },
                explanation: {
                  type: 'string',
                  description: 'User-friendly explanation of what went wrong',
                },
                affectedNodes: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Names of nodes affected by or causing the error',
                },
                suggestedFix: {
                  type: 'object',
                  properties: {
                    description: {
                      type: 'string',
                      description: 'Human-readable description of the fix',
                    },
                    changes: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          nodeName: { type: 'string' },
                          changeType: {
                            type: 'string',
                            enum: ['modify_node', 'add_node', 'remove_node', 'modify_connection', 'modify_settings'],
                          },
                          path: { type: 'string' },
                          newValue: {},
                          description: { type: 'string' },
                        },
                        required: ['changeType', 'newValue', 'description'],
                      },
                    },
                    rollbackPossible: {
                      type: 'boolean',
                      description: 'Whether the change can be easily reverted',
                    },
                  },
                  required: ['description', 'changes', 'rollbackPossible'],
                },
                confidence: {
                  type: 'string',
                  enum: ['high', 'medium', 'low'],
                  description: 'Confidence level in the diagnosis and fix',
                },
                relatedSkills: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Names of relevant n8n skills/documentation',
                },
              },
              required: ['rootCause', 'explanation', 'affectedNodes', 'suggestedFix', 'confidence', 'relatedSkills'],
            },
          },
        ],
        tool_choice: { type: 'tool', name: 'provide_analysis' },
      });

      // Extract tool use response
      const toolUse = response.content.find((block) => block.type === 'tool_use');
      if (!toolUse || toolUse.type !== 'tool_use') {
        throw new Error('No tool use response from Claude');
      }

      const analysis = toolUse.input as ClaudeAnalysisResponse;

      // Generate fix ID
      const fixId = uuidv4();

      return {
        rootCause: analysis.rootCause,
        explanation: analysis.explanation,
        affectedNodes: analysis.affectedNodes,
        suggestedFix: {
          id: fixId,
          description: analysis.suggestedFix.description,
          changes: analysis.suggestedFix.changes,
          rollbackPossible: analysis.suggestedFix.rollbackPossible,
        },
        confidence: analysis.confidence,
        relatedSkills: analysis.relatedSkills,
      };
    } catch (error) {
      logger.error('Claude analysis failed', { error: (error as Error).message });
      throw error;
    }
  }

  private buildPrompt(context: AnalysisContext): string {
    const { errorPayload, workflow, skills, nodeDocumentation } = context;

    let prompt = `## Error Information

**Workflow ID:** ${workflow.id}
**Workflow Name:** ${workflow.name}
**Error Message:** ${errorPayload.errorMessage}
`;

    if (errorPayload.nodeName) {
      prompt += `**Node Name:** ${errorPayload.nodeName}\n`;
    }

    if (errorPayload.nodeType) {
      prompt += `**Node Type:** ${errorPayload.nodeType}\n`;
    }

    if (errorPayload.executionId) {
      prompt += `**Execution ID:** ${errorPayload.executionId}\n`;
    }

    if (errorPayload.errorStack) {
      prompt += `\n**Error Stack:**\n\`\`\`\n${errorPayload.errorStack.slice(0, 1000)}\n\`\`\`\n`;
    }

    if (errorPayload.inputData) {
      prompt += `\n**Input Data:**\n\`\`\`json\n${JSON.stringify(errorPayload.inputData, null, 2).slice(0, 1000)}\n\`\`\`\n`;
    }

    // Add workflow structure
    prompt += `\n## Workflow Structure\n\n`;
    prompt += `**Nodes (${workflow.nodes.length}):**\n`;

    for (const node of workflow.nodes) {
      prompt += `- ${node.name} (${node.type})\n`;

      // Add relevant parameters for the error node
      if (node.name === errorPayload.nodeName) {
        prompt += `  **Parameters:**\n\`\`\`json\n${JSON.stringify(node.parameters, null, 2).slice(0, 500)}\n\`\`\`\n`;
      }
    }

    // Add connections overview
    prompt += `\n**Connections:**\n`;
    for (const [nodeName, connections] of Object.entries(workflow.connections)) {
      if (connections.main && connections.main.length > 0) {
        for (const outputs of connections.main) {
          for (const output of outputs) {
            prompt += `- ${nodeName} -> ${output.node}\n`;
          }
        }
      }
    }

    // Add relevant skills
    if (skills.length > 0) {
      prompt += `\n## Relevant n8n Documentation\n\n`;
      for (const skill of skills) {
        prompt += `### ${skill.name}\n${skill.description}\n\n`;
        if (skill.content) {
          // Include a snippet of the content
          prompt += `${skill.content.slice(0, 500)}...\n\n`;
        }
      }
    }

    // Add MCP node documentation if available
    if (nodeDocumentation) {
      prompt += `\n## Node Documentation (from n8n MCP)\n\n`;
      prompt += `${nodeDocumentation}\n\n`;
    }

    prompt += `\n## Task

Analyze this error and provide:
1. The root cause of the error
2. A clear explanation for non-technical users
3. A specific fix proposal with exact changes needed
4. Your confidence level in this analysis

Use the provide_analysis tool to return your structured response.`;

    return prompt;
  }

  async reviseFix(context: {
    originalAnalysis: ErrorAnalysis;
    userSuggestion: string;
    errorPayload: import('../types/index.js').ErrorPayload;
    workflow: import('../types/index.js').WorkflowData;
  }): Promise<ErrorAnalysis> {
    const { originalAnalysis, userSuggestion, errorPayload, workflow } = context;

    logger.info('Revising fix based on user suggestion', {
      workflowId: workflow.id,
      suggestion: userSuggestion.slice(0, 100),
    });

    const prompt = `## Original Error

**Workflow:** ${workflow.name}
**Error:** ${errorPayload.errorMessage}
**Node:** ${errorPayload.nodeName || 'Unknown'}

## Original Analysis

**Root Cause:** ${originalAnalysis.rootCause}
**Explanation:** ${originalAnalysis.explanation}
**Proposed Fix:** ${originalAnalysis.suggestedFix.description}
**Changes:**
${originalAnalysis.suggestedFix.changes.map((c) => `- [${c.changeType}] ${c.description}`).join('\n')}

## User Feedback

The user has provided the following suggestion or feedback on the proposed fix:

"${userSuggestion}"

## Workflow Structure

**Nodes:**
${workflow.nodes.map((n) => `- ${n.name} (${n.type})`).join('\n')}

**Node Details for "${errorPayload.nodeName}":**
\`\`\`json
${JSON.stringify(workflow.nodes.find((n) => n.name === errorPayload.nodeName)?.parameters || {}, null, 2).slice(0, 1500)}
\`\`\`

## Task

Based on the user's feedback, revise your analysis and proposed fix. Consider:
1. Whether the user's suggestion addresses the root cause better
2. How to incorporate their feedback into a concrete fix
3. Any additional changes needed based on their insight

Provide a revised analysis using the provide_analysis tool.`;

    try {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
        tools: [
          {
            name: 'provide_analysis',
            description: 'Provide the revised error analysis and fix proposal',
            input_schema: {
              type: 'object',
              properties: {
                rootCause: { type: 'string', description: 'Technical root cause of the error' },
                explanation: { type: 'string', description: 'User-friendly explanation of what went wrong' },
                affectedNodes: { type: 'array', items: { type: 'string' }, description: 'Names of affected nodes' },
                suggestedFix: {
                  type: 'object',
                  properties: {
                    description: { type: 'string', description: 'Human-readable description of the fix' },
                    changes: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          nodeName: { type: 'string' },
                          changeType: { type: 'string', enum: ['modify_node', 'add_node', 'remove_node', 'modify_connection', 'modify_settings'] },
                          path: { type: 'string' },
                          newValue: {},
                          description: { type: 'string' },
                        },
                        required: ['changeType', 'newValue', 'description'],
                      },
                    },
                    rollbackPossible: { type: 'boolean' },
                  },
                  required: ['description', 'changes', 'rollbackPossible'],
                },
                confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                relatedSkills: { type: 'array', items: { type: 'string' } },
              },
              required: ['rootCause', 'explanation', 'affectedNodes', 'suggestedFix', 'confidence', 'relatedSkills'],
            },
          },
        ],
        tool_choice: { type: 'tool', name: 'provide_analysis' },
      });

      const toolUse = response.content.find((block) => block.type === 'tool_use');
      if (!toolUse || toolUse.type !== 'tool_use') {
        throw new Error('No tool use response from Claude');
      }

      const analysis = toolUse.input as ClaudeAnalysisResponse;
      const fixId = uuidv4();

      return {
        rootCause: analysis.rootCause,
        explanation: analysis.explanation,
        affectedNodes: analysis.affectedNodes,
        suggestedFix: {
          id: fixId,
          description: analysis.suggestedFix.description,
          changes: analysis.suggestedFix.changes,
          rollbackPossible: analysis.suggestedFix.rollbackPossible,
        },
        confidence: analysis.confidence,
        relatedSkills: analysis.relatedSkills,
      };
    } catch (error) {
      logger.error('Claude revision failed', { error: (error as Error).message });
      throw error;
    }
  }
}

// Singleton instance
export const claudeClient = new ClaudeClient();
