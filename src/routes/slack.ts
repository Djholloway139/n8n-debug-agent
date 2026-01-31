import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { approvalStore } from '../services/approvalStore.js';
import { slackClient } from '../services/slack.js';
import { n8nClient } from '../services/n8n.js';
import { claudeClient } from '../services/claude.js';
import { applyFix, generatePatchDescription } from '../analyzers/fixGenerator.js';

export const slackRouter = Router();

interface SlackActionPayload {
  type: string;
  trigger_id: string;
  user: {
    id: string;
    username: string;
    name: string;
  };
  channel: {
    id: string;
  };
  message: {
    ts: string;
  };
  actions: Array<{
    action_id: string;
    value: string;
    block_id: string;
  }>;
  response_url: string;
}

interface SlackViewSubmissionPayload {
  type: 'view_submission';
  user: {
    id: string;
    username: string;
    name: string;
  };
  view: {
    callback_id: string;
    private_metadata: string;
    state: {
      values: {
        suggestion_input?: {
          suggestion_text: {
            value: string;
          };
        };
        proposal_request_input?: {
          proposal_request_text: {
            value: string;
          };
        };
      };
    };
  };
}

// Slack sends actions as form-urlencoded with a 'payload' field
slackRouter.post('/actions', async (req: Request, res: Response) => {
  // Parse the payload
  let payload: SlackActionPayload | SlackViewSubmissionPayload;
  try {
    const rawPayload = req.body.payload;
    if (!rawPayload) {
      logger.warn('No payload in Slack action request');
      return res.status(400).send('Missing payload');
    }
    payload = JSON.parse(rawPayload);
  } catch {
    logger.error('Failed to parse Slack payload');
    return res.status(400).send('Invalid payload');
  }

  // Verify Slack signature
  if (!verifySlackSignature(req)) {
    logger.warn('Invalid Slack signature');
    return res.status(401).send('Invalid signature');
  }

  // Handle view submissions (modal form submissions)
  if (payload.type === 'view_submission') {
    // Acknowledge immediately for modals
    res.status(200).send();

    const viewPayload = payload as SlackViewSubmissionPayload;
    const callbackId = viewPayload.view.callback_id;

    // Route to appropriate handler based on callback_id
    if (callbackId.startsWith('proposal_request_modal_')) {
      processProposalRequest(viewPayload).catch((error) => {
        logger.error('Failed to process proposal request', { error: (error as Error).message });
      });
    } else {
      // Default: process as conversation message
      processSuggestion(viewPayload).catch((error) => {
        logger.error('Failed to process suggestion', { error: (error as Error).message });
      });
    }
    return;
  }

  // Acknowledge immediately for button actions
  res.status(200).send();

  // Process the action asynchronously
  processAction(payload as SlackActionPayload).catch((error) => {
    logger.error('Failed to process Slack action', { error: (error as Error).message });
  });
});

async function processAction(payload: SlackActionPayload): Promise<void> {
  const action = payload.actions[0];
  if (!action) {
    logger.warn('No action in payload');
    return;
  }

  const approvalId = action.value;
  const actionId = action.action_id;

  logger.info('Processing Slack action', {
    actionId,
    approvalId,
    user: payload.user.username,
  });

  const record = approvalStore.get(approvalId);
  if (!record) {
    logger.warn('Approval record not found', { approvalId });
    await respondToSlack(payload, 'Approval record not found or expired');
    return;
  }

  if (record.status !== 'pending') {
    logger.warn('Approval already processed', { approvalId, status: record.status });
    await respondToSlack(payload, `This approval has already been ${record.status}`);
    return;
  }

  if (actionId === 'approve_fix') {
    await handleApproval(record.id, payload);
  } else if (actionId === 'reject_fix') {
    await handleRejection(record.id, payload);
  } else if (actionId === 'suggest_fix' || actionId === 'continue_conversation') {
    await handleSuggestFix(record.id, payload);
  } else if (actionId === 'request_proposal') {
    await handleRequestProposal(record.id, payload);
  } else {
    logger.warn('Unknown action', { actionId });
  }
}

async function handleSuggestFix(approvalId: string, payload: SlackActionPayload): Promise<void> {
  const record = approvalStore.get(approvalId);
  logger.info('Opening suggestion modal', {
    approvalId,
    user: payload.user.username,
    hasConversation: !!(record?.conversationHistory?.length),
  });

  await slackClient.openSuggestionModal(
    payload.trigger_id,
    approvalId,
    record?.conversationHistory
  );
}

async function handleRequestProposal(approvalId: string, payload: SlackActionPayload): Promise<void> {
  const record = approvalStore.get(approvalId);
  logger.info('Opening proposal request modal', {
    approvalId,
    user: payload.user.username,
    conversationLength: record?.conversationHistory?.length || 0,
  });

  await slackClient.openProposalRequestModal(
    payload.trigger_id,
    approvalId,
    record?.conversationHistory
  );
}

async function processSuggestion(payload: SlackViewSubmissionPayload): Promise<void> {
  const approvalId = payload.view.private_metadata;
  const userMessage = payload.view.state.values.suggestion_input?.suggestion_text.value;

  if (!userMessage) {
    logger.warn('No message in suggestion payload', { approvalId });
    return;
  }

  logger.info('Processing user conversation message', { approvalId, user: payload.user.username });

  const record = approvalStore.get(approvalId);
  if (!record) {
    logger.warn('Approval record not found for suggestion', { approvalId });
    return;
  }

  try {
    // Get current conversation history
    const conversationHistory = record.conversationHistory || [];

    // Generate a conversational reply using Claude
    const response = await claudeClient.generateConversationReply({
      errorPayload: record.errorPayload,
      workflow: record.originalWorkflow,
      originalAnalysis: record.analysis,
      skills: record.skills,
      nodeDocumentation: record.nodeDocumentation,
      conversationHistory,
      userMessage,
    });

    // Update conversation history
    const updatedHistory = [
      ...conversationHistory,
      { role: 'user' as const, content: userMessage, timestamp: new Date() },
      { role: 'assistant' as const, content: response.reply, timestamp: new Date() },
    ];

    approvalStore.update(approvalId, {
      conversationHistory: updatedHistory,
    });

    // Post the conversation reply to the thread
    await slackClient.postConversationReply(
      record.slackChannelId!,
      record.slackMessageTs!,
      approvalId,
      userMessage,
      response.reply,
      response.relevantDocs
    );

    logger.info('Conversation reply posted', { approvalId, conversationLength: updatedHistory.length });
  } catch (error) {
    logger.error('Failed to process conversation message', { approvalId, error: (error as Error).message });

    // Notify user of failure in thread
    await slackClient.updateMessage(
      record.slackChannelId!,
      record.slackMessageTs!,
      'failed',
      `Failed to process your message: ${(error as Error).message}`
    );
  }
}

async function processProposalRequest(payload: SlackViewSubmissionPayload): Promise<void> {
  const approvalId = payload.view.private_metadata;
  const userRequest = payload.view.state.values.proposal_request_input?.proposal_request_text.value || 'Please generate a new proposal based on our conversation.';

  logger.info('Processing proposal request', { approvalId, user: payload.user.username });

  const record = approvalStore.get(approvalId);
  if (!record) {
    logger.warn('Approval record not found for proposal request', { approvalId });
    return;
  }

  try {
    // Use Claude to generate a revised fix with full context
    const revisedAnalysis = await claudeClient.reviseFix({
      originalAnalysis: record.analysis,
      userSuggestion: userRequest,
      errorPayload: record.errorPayload,
      workflow: record.originalWorkflow,
      skills: record.skills,
      nodeDocumentation: record.nodeDocumentation,
      conversationHistory: record.conversationHistory,
    });

    // Update the approval record with the revised analysis
    // Clear conversation history since we're starting fresh with a new proposal
    approvalStore.update(approvalId, {
      analysis: revisedAnalysis,
      proposal: revisedAnalysis.suggestedFix,
      conversationHistory: [],
    });

    // Post the revised proposal to the thread
    await slackClient.postRevisedProposal(
      record.slackChannelId!,
      record.slackMessageTs!,
      approvalId,
      userRequest,
      revisedAnalysis.explanation,
      revisedAnalysis.suggestedFix.changes.map((c, i) => `${i + 1}. [${c.changeType}] ${c.description}`).join('\n')
    );

    logger.info('Revised proposal posted from conversation', {
      approvalId,
      conversationMessagesUsed: record.conversationHistory?.length || 0,
    });
  } catch (error) {
    logger.error('Failed to generate proposal from conversation', { approvalId, error: (error as Error).message });

    // Notify user of failure in thread
    await slackClient.updateMessage(
      record.slackChannelId!,
      record.slackMessageTs!,
      'failed',
      `Failed to generate new proposal: ${(error as Error).message}`
    );
  }
}

async function handleApproval(approvalId: string, payload: SlackActionPayload): Promise<void> {
  const record = approvalStore.get(approvalId);
  if (!record) return;

  logger.info('Approval granted', {
    approvalId,
    workflowId: record.workflowId,
    user: payload.user.username,
  });

  // Update status to approved
  approvalStore.updateStatus(approvalId, 'approved');

  // Notify Slack that we're applying the fix
  await slackClient.updateMessage(
    record.slackChannelId!,
    record.slackMessageTs!,
    'approved',
    `Approved by @${payload.user.username}`
  );

  try {
    // Apply the fix
    const patchResult = applyFix(record.originalWorkflow, record.analysis);

    if (!patchResult.success) {
      throw new Error(patchResult.error || 'Failed to generate patch');
    }

    // Update the workflow in n8n (send full workflow for PUT)
    // Pass original workflow to preserve credentials
    await n8nClient.updateWorkflow(record.workflowId, patchResult.patchedWorkflow!, record.originalWorkflow);

    // Update status to applied
    approvalStore.updateStatus(approvalId, 'applied');

    // Send success message
    const patchDescription = generatePatchDescription(record.analysis);
    await slackClient.updateMessage(
      record.slackChannelId!,
      record.slackMessageTs!,
      'applied',
      `Applied ${patchResult.appliedChanges.length} change(s):\n${patchResult.appliedChanges.map((c) => `• ${c}`).join('\n')}${
        patchResult.skippedChanges.length > 0
          ? `\n\nSkipped ${patchResult.skippedChanges.length} change(s):\n${patchResult.skippedChanges.map((c) => `• ${c}`).join('\n')}`
          : ''
      }`
    );

    logger.info('Fix applied successfully', {
      approvalId,
      workflowId: record.workflowId,
      appliedChanges: patchResult.appliedChanges.length,
    });
  } catch (error) {
    logger.error('Failed to apply fix', {
      approvalId,
      error: (error as Error).message,
    });

    // Update status
    approvalStore.update(approvalId, { status: 'pending' }); // Reset to pending for retry

    await slackClient.updateMessage(
      record.slackChannelId!,
      record.slackMessageTs!,
      'failed',
      `Error: ${(error as Error).message}\n\nThe fix could not be applied. Please review and try again or apply manually.`
    );
  }
}

async function handleRejection(approvalId: string, payload: SlackActionPayload): Promise<void> {
  const record = approvalStore.get(approvalId);
  if (!record) return;

  logger.info('Approval rejected', {
    approvalId,
    workflowId: record.workflowId,
    user: payload.user.username,
  });

  // Update status
  approvalStore.updateStatus(approvalId, 'rejected');

  // Notify Slack
  await slackClient.updateMessage(
    record.slackChannelId!,
    record.slackMessageTs!,
    'rejected',
    `Rejected by @${payload.user.username}`
  );
}

async function respondToSlack(payload: SlackActionPayload, message: string): Promise<void> {
  try {
    const response = await fetch(payload.response_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: message,
        response_type: 'ephemeral',
      }),
    });

    if (!response.ok) {
      logger.warn('Failed to respond to Slack', { status: response.status });
    }
  } catch (error) {
    logger.error('Error responding to Slack', { error: (error as Error).message });
  }
}

function verifySlackSignature(req: Request): boolean {
  // In development, skip verification
  if (config.nodeEnv === 'development') {
    return true;
  }

  const signature = req.headers['x-slack-signature'] as string;
  const timestamp = req.headers['x-slack-request-timestamp'] as string;

  if (!signature || !timestamp) {
    return false;
  }

  // Check timestamp is recent (within 5 minutes)
  const time = Math.floor(Date.now() / 1000);
  if (Math.abs(time - parseInt(timestamp, 10)) > 300) {
    return false;
  }

  // Reconstruct the signature base string
  const rawBody = (req as Request & { rawBody?: string }).rawBody || JSON.stringify(req.body);
  const sigBasestring = `v0:${timestamp}:${rawBody}`;

  // Calculate expected signature
  const hmac = crypto.createHmac('sha256', config.slackSigningSecret);
  hmac.update(sigBasestring);
  const mySignature = `v0=${hmac.digest('hex')}`;

  // Compare signatures using timing-safe comparison
  try {
    return crypto.timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature));
  } catch {
    return false;
  }
}
