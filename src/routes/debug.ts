import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger, createRequestLogger } from '../utils/logger.js';
import { n8nClient } from '../services/n8n.js';
import { claudeClient } from '../services/claude.js';
import { skillsService } from '../services/skills.js';
import { mcpService } from '../services/mcp.js';
import { slackClient } from '../services/slack.js';
import { approvalStore } from '../services/approvalStore.js';
import { parseError } from '../analyzers/errorParser.js';
import type { ErrorPayload, DebugResult } from '../types/index.js';

export const debugRouter = Router();

interface DebugRequest extends Request {
  body: ErrorPayload;
  requestId?: string;
}

debugRouter.post('/', async (req: DebugRequest, res: Response<DebugResult>) => {
  const requestId = req.requestId || uuidv4();
  const log = createRequestLogger(requestId);

  log.info('Debug request received', {
    workflowId: req.body.workflowId,
    errorMessage: req.body.errorMessage?.slice(0, 100),
  });

  try {
    // Validate payload
    const validation = validatePayload(req.body);
    if (!validation.valid) {
      log.warn('Invalid payload', { errors: validation.errors });
      return res.status(400).json({
        success: false,
        error: `Invalid payload: ${validation.errors.join(', ')}`,
        message: 'Request validation failed',
      });
    }

    const payload = req.body;

    // Fetch workflow from n8n
    log.info('Fetching workflow', { workflowId: payload.workflowId });
    let workflow;
    try {
      workflow = await n8nClient.getWorkflow(payload.workflowId);
    } catch (error) {
      log.error('Failed to fetch workflow', { error: (error as Error).message });
      return res.status(404).json({
        success: false,
        error: `Workflow not found: ${payload.workflowId}`,
        message: 'Could not retrieve workflow from n8n',
      });
    }

    // Parse the error to understand its nature
    const parsedError = parseError(payload, workflow);
    log.info('Error parsed', {
      category: parsedError.category,
      severity: parsedError.severity,
    });

    // Fetch relevant skills based on error context
    log.info('Fetching relevant skills');
    const allSkills = await skillsService.fetchSkills();
    const relevantSkills = skillsService.filterSkillsForError(
      allSkills,
      parsedError.nodeType,
      payload.errorMessage
    );
    log.debug('Skills filtered', { count: relevantSkills.length });

    // Fetch node documentation from MCP (if available)
    let nodeDocumentation: string | undefined;
    if (parsedError.nodeType) {
      log.info('Fetching node documentation from MCP', { nodeType: parsedError.nodeType });
      const mcpDoc = await mcpService.getNodeDocumentation(parsedError.nodeType);
      if (mcpDoc?.documentation) {
        nodeDocumentation = mcpDoc.documentation;
        log.debug('MCP documentation fetched', { nodeType: parsedError.nodeType, docLength: nodeDocumentation.length });
      }
    }

    // Analyze error with Claude
    log.info('Analyzing error with Claude');
    const analysis = await claudeClient.analyzeError({
      errorPayload: payload,
      workflow,
      skills: relevantSkills,
      nodeDocumentation,
    });

    log.info('Analysis complete', {
      confidence: analysis.confidence,
      affectedNodes: analysis.affectedNodes,
      changesCount: analysis.suggestedFix.changes.length,
    });

    // Create approval record
    const approvalId = uuidv4();
    const approvalRecord = approvalStore.create({
      id: approvalId,
      workflowId: payload.workflowId,
      workflowName: workflow.name,
      executionId: payload.executionId,
      errorPayload: payload,
      analysis,
      proposal: analysis.suggestedFix,
      originalWorkflow: workflow,
      skills: relevantSkills,
      nodeDocumentation,
    });

    // Send to Slack for approval
    log.info('Sending approval request to Slack');
    try {
      const slackMessage = await slackClient.sendProposal(approvalRecord);
      if (slackMessage) {
        approvalStore.update(approvalId, {
          slackMessageTs: slackMessage.ts,
          slackChannelId: slackMessage.channel,
        });
      } else {
        log.warn('Slack not configured, approval stored but no notification sent');
      }
    } catch (slackError) {
      log.error('Failed to send Slack message', { error: (slackError as Error).message });
      // Continue anyway - the fix is still in the approval store
    }

    log.info('Debug flow complete', { approvalId });

    return res.json({
      success: true,
      approvalId,
      analysis,
      message: 'Error analyzed and fix proposed. Awaiting approval in Slack.',
    });
  } catch (error) {
    log.error('Debug flow failed', { error: (error as Error).message, stack: (error as Error).stack });

    return res.status(500).json({
      success: false,
      error: (error as Error).message,
      message: 'An error occurred while processing the debug request',
    });
  }
});

// Get status of an approval
debugRouter.get('/approval/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const record = approvalStore.get(id);

  if (!record) {
    return res.status(404).json({
      success: false,
      error: 'Approval not found',
      message: `No approval record found with ID: ${id}`,
    });
  }

  return res.json({
    success: true,
    approval: {
      id: record.id,
      workflowId: record.workflowId,
      workflowName: record.workflowName,
      status: record.status,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      analysis: record.analysis,
    },
  });
});

// List pending approvals
debugRouter.get('/approvals', (_req: Request, res: Response) => {
  const pending = approvalStore.getPending();

  return res.json({
    success: true,
    approvals: pending.map((r) => ({
      id: r.id,
      workflowId: r.workflowId,
      workflowName: r.workflowName,
      status: r.status,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    })),
  });
});

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function validatePayload(payload: unknown): ValidationResult {
  const errors: string[] = [];

  if (!payload || typeof payload !== 'object') {
    return { valid: false, errors: ['Payload must be an object'] };
  }

  const p = payload as Record<string, unknown>;

  if (!p.workflowId || typeof p.workflowId !== 'string') {
    errors.push('workflowId is required and must be a string');
  }

  if (!p.errorMessage || typeof p.errorMessage !== 'string') {
    errors.push('errorMessage is required and must be a string');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
