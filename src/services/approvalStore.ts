import { logger } from '../utils/logger.js';
import type { ApprovalRecord } from '../types/index.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

class ApprovalStore {
  private approvals: Map<string, ApprovalRecord> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start cleanup interval
    this.startCleanup();
  }

  private startCleanup(): void {
    // Clean up expired approvals every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, 5 * 60 * 1000);
  }

  private cleanupExpired(): void {
    const now = new Date();
    let expiredCount = 0;

    for (const [id, record] of this.approvals) {
      if (record.status === 'pending' && now > record.expiresAt) {
        record.status = 'expired';
        expiredCount++;
        logger.info('Approval expired', { approvalId: id });
      }
    }

    if (expiredCount > 0) {
      logger.info('Cleaned up expired approvals', { count: expiredCount });
    }
  }

  create(record: Omit<ApprovalRecord, 'createdAt' | 'expiresAt' | 'status'>): ApprovalRecord {
    const now = new Date();
    const fullRecord: ApprovalRecord = {
      ...record,
      status: 'pending',
      createdAt: now,
      expiresAt: new Date(now.getTime() + DEFAULT_TTL_MS),
    };

    this.approvals.set(record.id, fullRecord);
    logger.info('Approval record created', { approvalId: record.id, workflowId: record.workflowId });

    return fullRecord;
  }

  get(id: string): ApprovalRecord | undefined {
    return this.approvals.get(id);
  }

  update(id: string, updates: Partial<ApprovalRecord>): ApprovalRecord | undefined {
    const record = this.approvals.get(id);
    if (!record) {
      logger.warn('Approval record not found', { approvalId: id });
      return undefined;
    }

    const updatedRecord = { ...record, ...updates };
    this.approvals.set(id, updatedRecord);
    logger.info('Approval record updated', { approvalId: id, status: updatedRecord.status });

    return updatedRecord;
  }

  updateStatus(id: string, status: ApprovalRecord['status']): ApprovalRecord | undefined {
    return this.update(id, { status });
  }

  getBySlackMessage(channelId: string, messageTs: string): ApprovalRecord | undefined {
    for (const record of this.approvals.values()) {
      if (record.slackChannelId === channelId && record.slackMessageTs === messageTs) {
        return record;
      }
    }
    return undefined;
  }

  getPending(): ApprovalRecord[] {
    return Array.from(this.approvals.values()).filter((r) => r.status === 'pending');
  }

  getByWorkflow(workflowId: string): ApprovalRecord[] {
    return Array.from(this.approvals.values()).filter((r) => r.workflowId === workflowId);
  }

  delete(id: string): boolean {
    const result = this.approvals.delete(id);
    if (result) {
      logger.info('Approval record deleted', { approvalId: id });
    }
    return result;
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.approvals.clear();
  }
}

// Singleton instance
export const approvalStore = new ApprovalStore();
