import pkg from '@slack/bolt';
const { App, LogLevel } = pkg;
import type { KnownBlock, App as AppType } from '@slack/bolt';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type { ErrorAnalysis, ApprovalRecord } from '../types/index.js';

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

  getBoltApp(): AppType | null {
    return this.app;
  }

  isReady(): boolean {
    return this.initialized;
  }
}

// Singleton instance
export const slackClient = new SlackClient();
