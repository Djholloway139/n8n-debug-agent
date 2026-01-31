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
  ConversationMessage,
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
    errorPayload: ErrorPayload;
    workflow: WorkflowData;
    skills?: N8nSkill[];
    nodeDocumentation?: string;
    conversationHistory?: ConversationMessage[];
  }): Promise<ErrorAnalysis> {
    const { originalAnalysis, userSuggestion, errorPayload, workflow, skills, nodeDocumentation, conversationHistory } = context;

    logger.info('Revising fix based on user suggestion', {
      workflowId: workflow.id,
      suggestion: userSuggestion.slice(0, 100),
      hasSkills: !!skills?.length,
      hasNodeDocs: !!nodeDocumentation,
      conversationLength: conversationHistory?.length || 0,
    });

    let prompt = `## Original Error

**Workflow:** ${workflow.name}
**Error:** ${errorPayload.errorMessage}
**Node:** ${errorPayload.nodeName || 'Unknown'}

## Original Analysis

**Root Cause:** ${originalAnalysis.rootCause}
**Explanation:** ${originalAnalysis.explanation}
**Proposed Fix:** ${originalAnalysis.suggestedFix.description}
**Changes:**
${originalAnalysis.suggestedFix.changes.map((c) => `- [${c.changeType}] ${c.description}`).join('\n')}

## Workflow Structure

**Nodes:**
${workflow.nodes.map((n) => `- ${n.name} (${n.type})`).join('\n')}

**Node Details for "${errorPayload.nodeName}":**
\`\`\`json
${JSON.stringify(workflow.nodes.find((n) => n.name === errorPayload.nodeName)?.parameters || {}, null, 2).slice(0, 1500)}
\`\`\`
`;

    // Add relevant skills documentation
    if (skills && skills.length > 0) {
      prompt += `\n## Relevant n8n Documentation\n\n`;
      for (const skill of skills) {
        prompt += `### ${skill.name}\n${skill.description}\n\n`;
        if (skill.content) {
          prompt += `${skill.content.slice(0, 500)}...\n\n`;
        }
      }
    }

    // Add MCP node documentation if available
    if (nodeDocumentation) {
      prompt += `\n## Node Documentation (from n8n MCP)\n\n`;
      prompt += `${nodeDocumentation}\n\n`;
    }

    // Add conversation history if available
    if (conversationHistory && conversationHistory.length > 0) {
      prompt += `\n## Previous Conversation\n\n`;
      prompt += `The user has been discussing this issue with the agent. Here is the conversation so far:\n\n`;
      for (const msg of conversationHistory) {
        const role = msg.role === 'user' ? 'User' : 'Agent';
        prompt += `**${role}:** ${msg.content}\n\n`;
      }
    }

    prompt += `## User's Request for New Proposal

The user has requested a new fix proposal based on the conversation:

"${userSuggestion}"

## Task

Based on the conversation and the user's final request, create a revised fix proposal.

CRITICAL REQUIREMENTS:
1. ONLY suggest features and options that are documented in the n8n documentation above
2. If the documentation doesn't mention a feature, DO NOT suggest it exists
3. If you're unsure about a capability, indicate lower confidence and suggest alternative approaches
4. Focus on concrete, actionable changes that can be verified against the documentation

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

  async generateConversationReply(context: {
    errorPayload: ErrorPayload;
    workflow: WorkflowData;
    originalAnalysis: ErrorAnalysis;
    skills?: N8nSkill[];
    nodeDocumentation?: string;
    conversationHistory: ConversationMessage[];
    userMessage: string;
  }): Promise<{ reply: string; relevantDocs?: string }> {
    const { errorPayload, workflow, originalAnalysis, skills, nodeDocumentation, conversationHistory, userMessage } = context;

    logger.info('Generating conversation reply', {
      workflowId: workflow.id,
      userMessage: userMessage.slice(0, 100),
      conversationLength: conversationHistory.length,
    });

    let prompt = `## Context

You are helping debug an n8n workflow error. The user is asking questions or discussing the issue with you.

**Workflow:** ${workflow.name}
**Error:** ${errorPayload.errorMessage}
**Node:** ${errorPayload.nodeName || 'Unknown'}

## Current Proposed Fix

**Root Cause:** ${originalAnalysis.rootCause}
**Explanation:** ${originalAnalysis.explanation}
**Proposed Fix:** ${originalAnalysis.suggestedFix.description}
`;

    // Add relevant skills documentation
    if (skills && skills.length > 0) {
      prompt += `\n## Relevant n8n Documentation\n\n`;
      for (const skill of skills) {
        prompt += `### ${skill.name}\n${skill.description}\n\n`;
        if (skill.content) {
          prompt += `${skill.content.slice(0, 800)}...\n\n`;
        }
      }
    }

    // Add MCP node documentation if available
    if (nodeDocumentation) {
      prompt += `\n## Node Documentation (from n8n MCP)\n\n`;
      prompt += `${nodeDocumentation}\n\n`;
    }

    // Add conversation history
    if (conversationHistory.length > 0) {
      prompt += `\n## Conversation So Far\n\n`;
      for (const msg of conversationHistory) {
        const role = msg.role === 'user' ? 'User' : 'You';
        prompt += `**${role}:** ${msg.content}\n\n`;
      }
    }

    prompt += `## User's Latest Message

"${userMessage}"

## Your Task

Respond to the user's message. Important guidelines:

1. **Be accurate**: Only reference features that exist in the documentation provided above
2. **Quote documentation**: When answering about n8n capabilities, cite specific documentation
3. **Be honest**: If you're unsure whether a feature exists, say so clearly
4. **Be helpful**: Guide the user toward a solution that will actually work
5. **Don't generate fixes yet**: This is a conversation - the user will click "Request New Proposal" when ready for a fix

If the user is asking whether a feature exists:
- Check the documentation provided
- If it's documented, confirm and quote the relevant section
- If it's NOT documented, say so clearly and suggest alternatives

Provide your response using the provide_conversation_reply tool.`;

    try {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        system: `You are an expert n8n workflow debugging assistant having a conversation with a user. You help them understand their workflow error and explore solutions. Be conversational, accurate, and helpful. Never invent features that don't exist in the documentation - if you're not sure about something, say so.`,
        messages: [{ role: 'user', content: prompt }],
        tools: [
          {
            name: 'provide_conversation_reply',
            description: 'Provide a conversational reply to the user',
            input_schema: {
              type: 'object',
              properties: {
                reply: {
                  type: 'string',
                  description: 'Your conversational response to the user',
                },
                relevantDocs: {
                  type: 'string',
                  description: 'Key documentation snippets that informed your answer (if any). Include specific quotes from the documentation.',
                },
              },
              required: ['reply'],
            },
          },
        ],
        tool_choice: { type: 'tool', name: 'provide_conversation_reply' },
      });

      const toolUse = response.content.find((block) => block.type === 'tool_use');
      if (!toolUse || toolUse.type !== 'tool_use') {
        throw new Error('No tool use response from Claude');
      }

      const result = toolUse.input as { reply: string; relevantDocs?: string };

      return {
        reply: result.reply,
        relevantDocs: result.relevantDocs,
      };
    } catch (error) {
      logger.error('Claude conversation reply failed', { error: (error as Error).message });
      throw error;
    }
  }
}

// Singleton instance
export const claudeClient = new ClaudeClient();
