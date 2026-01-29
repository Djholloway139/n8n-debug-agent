import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type { WorkflowData, ExecutionData } from '../types/index.js';

export class N8nClient {
  private client: AxiosInstance;
  private maxRetries = 3;
  private retryDelay = 1000;

  constructor() {
    this.client = axios.create({
      baseURL: config.n8nApiUrl,
      headers: {
        'X-N8N-API-KEY': config.n8nApiKey,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    // Add response interceptor for logging
    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        logger.error('n8n API error', {
          status: error.response?.status,
          message: error.message,
          url: error.config?.url,
        });
        throw error;
      }
    );
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        const axiosError = error as AxiosError;

        // Don't retry on 4xx errors (client errors)
        if (axiosError.response?.status && axiosError.response.status >= 400 && axiosError.response.status < 500) {
          throw error;
        }

        if (attempt < this.maxRetries) {
          logger.warn(`Retrying n8n API call (attempt ${attempt}/${this.maxRetries})`, {
            error: lastError.message,
          });
          await this.sleep(this.retryDelay * attempt);
        }
      }
    }

    throw lastError;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async getWorkflow(id: string): Promise<WorkflowData> {
    logger.info('Fetching workflow', { workflowId: id });

    return this.withRetry(async () => {
      const response = await this.client.get<WorkflowData>(`/workflows/${id}`);
      return response.data;
    });
  }

  async updateWorkflow(id: string, data: Partial<WorkflowData>): Promise<WorkflowData> {
    logger.info('Updating workflow', { workflowId: id });

    return this.withRetry(async () => {
      // n8n API requires PUT for workflow updates
      const response = await this.client.put<WorkflowData>(`/workflows/${id}`, data);
      return response.data;
    });
  }

  async getExecution(id: string): Promise<ExecutionData> {
    logger.info('Fetching execution', { executionId: id });

    return this.withRetry(async () => {
      const response = await this.client.get<ExecutionData>(`/executions/${id}`);
      return response.data;
    });
  }

  async activateWorkflow(id: string): Promise<WorkflowData> {
    logger.info('Activating workflow', { workflowId: id });

    return this.withRetry(async () => {
      const response = await this.client.patch<WorkflowData>(`/workflows/${id}`, { active: true });
      return response.data;
    });
  }

  async deactivateWorkflow(id: string): Promise<WorkflowData> {
    logger.info('Deactivating workflow', { workflowId: id });

    return this.withRetry(async () => {
      const response = await this.client.patch<WorkflowData>(`/workflows/${id}`, { active: false });
      return response.data;
    });
  }
}

// Singleton instance
export const n8nClient = new N8nClient();
