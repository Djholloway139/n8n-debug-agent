import pkg from '@slack/bolt';
const { App, LogLevel } = pkg;
import type { KnownBlock, App as AppType } from '@slack/bolt';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type { ErrorAnalysis, ApprovalRecord, ConversationMessage } from '../types/index.js';

export class SlackClient {
  private app: AppType | null = null;
  private initialized = false;
  private initError: string | null = null;

  private getApp(): AppType {
    if (!this.app) {
      this.app = new App({
        token: config.slackBotToken,
        signingSecret: config.slackSigningSecret,
        logLevel: config.nodeEnv === 'production' ? LogLevel.INFO : LogLevel.DEBUG,
      });
    }
    return this.app;
  }

  async initialize(): Promise<boolean> {
    if (this.initialized) return true;
    if (this.initError) return false;

    try {
      const result = await this.getApp().client.auth.test();
      logger.info('Slack connection established', { botId: result.bot_id, team: result.team });
      this.initialized = true;
      return true;
    } catch (error) {
      this.initError = (error as Error).message;
      logger.error('Failed to initialize Slack - proposals will not be sent', { error: this.initError });
      return false;
    }
  }

  async sendProposal(record: ApprovalRecord): Promise<{ ts: string; channel: string } | null> {
    const ready = await this.initialize();
    if (!ready) {
      logger.warn('Slack not available, skipping proposal', { approvalId: record.id });
      return null;
    }

    const blocks = this.formatProposalBlocks(record);

    try {
      const result = await this.getApp().client.chat.postMessage({
        channel: config.slackChannelId,
        text: `Fix proposal for workflow: ${record.workflowName}`,
        blocks,
      });

      if (!result.ts) {
        throw new Error('No message timestamp returned from Slack');
      }

      logger.info('Slack proposal sent', {
        approvalId: record.id,
        channel: result.channel,
        ts: result.ts,
      });

      return {
        ts: result.ts,
        channel: result.channel as string,
      };
    } catch (error) {
      logger.error('Failed to send Slack proposal', { error: (error as Error).message });
      throw error;
    }
  }

  private formatProposalBlocks(record: ApprovalRecord): KnownBlock[] {
    const { analysis, errorPayload, workflowName } = record;
    const confidenceEmoji = {
      high: ':white_check_mark:',
      medium: ':warning:',
      low: ':question:',
    };

    return [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `:wrench: Fix Proposal: ${workflowName}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Error:* ${errorPayload.errorMessage.slice(0, 200)}${errorPayload.errorMessage.length > 200 ? '...' : ''}`,
        },
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Root Cause:*\n${analysis.rootCause}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Explanation:*\n${analysis.explanation}`,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Affected Nodes:*\n${analysis.affectedNodes.join(', ') || 'None identified'}`,
          },
          {
            type: 'mrkdwn',
            text: `*Confidence:* ${confidenceEmoji[analysis.confidence]} ${analysis.confidence.toUpperCase()}`,
          },
        ],
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Proposed Fix:*\n${analysis.suggestedFix.description}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Changes (${analysis.suggestedFix.changes.length}):*\n${this.formatChanges(analysis.suggestedFix.changes)}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Workflow ID: \`${record.workflowId}\` | Execution: \`${record.executionId || 'N/A'}\` | Rollback: ${analysis.suggestedFix.rollbackPossible ? ':white_check_mark:' : ':x:'}`,
          },
        ],
      },
      {
        type: 'actions',
        block_id: `approval_${record.id}`,
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: ':white_check_mark: Approve & Apply',
              emoji: true,
            },
            style: 'primary',
            action_id: 'approve_fix',
            value: record.id,
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: ':bulb: Suggest Fix',
              emoji: true,
            },
            action_id: 'suggest_fix',
            value: record.id,
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: ':x: Reject',
              emoji: true,
            },
            style: 'danger',
            action_id: 'reject_fix',
            value: record.id,
          },
        ],
      },
    ];
  }

  private formatChanges(changes: ErrorAnalysis['suggestedFix']['changes']): string {
    if (changes.length === 0) {
      return 'No specific changes identified';
    }

    return changes
      .map((change, index) => {
        const nodeInfo = change.nodeName ? ` (${change.nodeName})` : '';
        return `${index + 1}. [${change.changeType}]${nodeInfo}: ${change.description}`;
      })
      .join('\n');
  }

  async updateMessage(
    channel: string,
    ts: string,
    status: 'approved' | 'rejected' | 'applied' | 'failed',
    additionalInfo?: string
  ): Promise<void> {
    const ready = await this.initialize();
    if (!ready) return;

    const statusEmoji = {
      approved: ':hourglass_flowing_sand:',
      rejected: ':no_entry:',
      applied: ':white_check_mark:',
      failed: ':x:',
    };

    const statusText = {
      approved: 'Approved - Applying fix...',
      rejected: 'Rejected by user',
      applied: 'Fix successfully applied!',
      failed: 'Fix application failed',
    };

    try {
      await this.getApp().client.chat.postMessage({
        channel,
        thread_ts: ts,
        text: `${statusEmoji[status]} *Status Update:* ${statusText[status]}${additionalInfo ? `\n${additionalInfo}` : ''}`,
      });

      logger.info('Slack status update sent', { channel, ts, status });
    } catch (error) {
      logger.error('Failed to update Slack message', { error: (error as Error).message });
    }
  }

  async openSuggestionModal(
    triggerId: string,
    approvalId: string,
    conversationHistory?: ConversationMessage[]
  ): Promise<void> {
    const ready = await this.initialize();
    if (!ready) return;

    const blocks: KnownBlock[] = [];

    // If there's conversation history, show a summary
    if (conversationHistory && conversationHistory.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Conversation so far:*',
        },
      });

      // Show last few messages (truncated)
      const recentMessages = conversationHistory.slice(-4);
      for (const msg of recentMessages) {
        const icon = msg.role === 'user' ? ':bust_in_silhouette:' : ':robot_face:';
        const content = msg.content.length > 150 ? msg.content.slice(0, 150) + '...' : msg.content;
        blocks.push({
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `${icon} ${content}`,
            },
          ],
        });
      }

      blocks.push({
        type: 'divider',
      });

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Continue the conversation or ask another question:',
        },
      });
    } else {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Ask a question about n8n capabilities or discuss the proposed fix. You can have a back-and-forth conversation before requesting a new proposal.',
        },
      });
    }

    blocks.push({
      type: 'input',
      block_id: 'suggestion_input',
      element: {
        type: 'plain_text_input',
        action_id: 'suggestion_text',
        multiline: true,
        placeholder: {
          type: 'plain_text',
          text: conversationHistory && conversationHistory.length > 0
            ? 'Continue the conversation...'
            : 'e.g., "Does the GitHub node have a Continue on Fail option?" or "What error handling options are available for this node?"',
        },
      },
      label: {
        type: 'plain_text',
        text: 'Your Message',
      },
    });

    try {
      await this.getApp().client.views.open({
        trigger_id: triggerId,
        view: {
          type: 'modal',
          callback_id: `suggestion_modal_${approvalId}`,
          title: {
            type: 'plain_text',
            text: conversationHistory && conversationHistory.length > 0 ? 'Continue Chat' : 'Ask a Question',
          },
          submit: {
            type: 'plain_text',
            text: 'Send',
          },
          close: {
            type: 'plain_text',
            text: 'Cancel',
          },
          blocks,
          private_metadata: approvalId,
        },
      });

      logger.info('Suggestion modal opened', { approvalId, hasConversation: !!(conversationHistory?.length) });
    } catch (error) {
      logger.error('Failed to open suggestion modal', { error: (error as Error).message });
    }
  }

  async postConversationReply(
    channel: string,
    threadTs: string,
    approvalId: string,
    userMessage: string,
    agentReply: string,
    relevantDocs?: string
  ): Promise<void> {
    const ready = await this.initialize();
    if (!ready) return;

    const blocks: KnownBlock[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:bust_in_silhouette: *You asked:*\n>${userMessage.split('\n').join('\n>')}`,
        },
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:robot_face: *Agent:*\n${agentReply}`,
        },
      },
    ];

    // Add relevant documentation if provided
    if (relevantDocs) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `:books: *Documentation referenced:*\n${relevantDocs.slice(0, 500)}${relevantDocs.length > 500 ? '...' : ''}`,
          },
        ],
      });
    }

    // Add action buttons for conversation flow
    blocks.push({
      type: 'actions',
      block_id: `conversation_${approvalId}`,
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: ':speech_balloon: Continue Chat',
            emoji: true,
          },
          action_id: 'continue_conversation',
          value: approvalId,
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: ':bulb: Request New Proposal',
            emoji: true,
          },
          style: 'primary',
          action_id: 'request_proposal',
          value: approvalId,
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: ':white_check_mark: Approve Current',
            emoji: true,
          },
          action_id: 'approve_fix',
          value: approvalId,
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: ':x: Reject',
            emoji: true,
          },
          style: 'danger',
          action_id: 'reject_fix',
          value: approvalId,
        },
      ],
    });

    try {
      await this.getApp().client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `Conversation reply`,
        blocks,
      });

      logger.info('Conversation reply posted', { approvalId, channel });
    } catch (error) {
      logger.error('Failed to post conversation reply', { error: (error as Error).message });
    }
  }

  async openProposalRequestModal(
    triggerId: string,
    approvalId: string,
    conversationHistory?: ConversationMessage[]
  ): Promise<void> {
    const ready = await this.initialize();
    if (!ready) return;

    const blocks: KnownBlock[] = [];

    // Show conversation summary
    if (conversationHistory && conversationHistory.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Based on your conversation:*',
        },
      });

      // Show conversation summary
      const recentMessages = conversationHistory.slice(-6);
      for (const msg of recentMessages) {
        const icon = msg.role === 'user' ? ':bust_in_silhouette:' : ':robot_face:';
        const content = msg.content.length > 100 ? msg.content.slice(0, 100) + '...' : msg.content;
        blocks.push({
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `${icon} ${content}`,
            },
          ],
        });
      }

      blocks.push({
        type: 'divider',
      });
    }

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Provide any final guidance for the new proposal. The agent will use your conversation and this message to generate a revised fix.',
      },
    });

    blocks.push({
      type: 'input',
      block_id: 'proposal_request_input',
      element: {
        type: 'plain_text_input',
        action_id: 'proposal_request_text',
        multiline: true,
        placeholder: {
          type: 'plain_text',
          text: 'e.g., "Based on our discussion, use the If node approach for error handling" or "Please create the fix we discussed"',
        },
      },
      label: {
        type: 'plain_text',
        text: 'Proposal Instructions',
      },
    });

    try {
      await this.getApp().client.views.open({
        trigger_id: triggerId,
        view: {
          type: 'modal',
          callback_id: `proposal_request_modal_${approvalId}`,
          title: {
            type: 'plain_text',
            text: 'Request New Proposal',
          },
          submit: {
            type: 'plain_text',
            text: 'Generate Proposal',
          },
          close: {
            type: 'plain_text',
            text: 'Cancel',
          },
          blocks,
          private_metadata: approvalId,
        },
      });

      logger.info('Proposal request modal opened', { approvalId });
    } catch (error) {
      logger.error('Failed to open proposal request modal', { error: (error as Error).message });
    }
  }

  async postRevisedProposal(
    channel: string,
    threadTs: string,
    approvalId: string,
    userSuggestion: string,
    revisedAnalysis: string,
    revisedChanges: string
  ): Promise<void> {
    const ready = await this.initialize();
    if (!ready) return;

    try {
      await this.getApp().client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: 'Revised fix proposal based on your feedback',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:speech_balloon: *Your Suggestion:*\n>${userSuggestion.split('\n').join('\n>')}`,
            },
          },
          {
            type: 'divider',
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:robot_face: *Revised Analysis:*\n${revisedAnalysis}`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Revised Changes:*\n${revisedChanges}`,
            },
          },
          {
            type: 'actions',
            block_id: `revised_approval_${approvalId}`,
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: ':white_check_mark: Approve Revised Fix',
                  emoji: true,
                },
                style: 'primary',
                action_id: 'approve_fix',
                value: approvalId,
              },
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: ':bulb: Suggest Another Fix',
                  emoji: true,
                },
                action_id: 'suggest_fix',
                value: approvalId,
              },
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: ':x: Reject',
                  emoji: true,
                },
                style: 'danger',
                action_id: 'reject_fix',
                value: approvalId,
              },
            ],
          },
        ],
      });

      logger.info('Revised proposal posted', { approvalId, channel });
    } catch (error) {
      logger.error('Failed to post revised proposal', { error: (error as Error).message });
    }
  }

  getBoltApp(): AppType | null {
    return this.app;
  }

  isReady(): boolean {
    return this.initialized;
  }
}

// Singleton instance
export const slackClient = new SlackClient();
