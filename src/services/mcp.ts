import axios from 'axios';
import { logger } from '../utils/logger.js';

// n8n-MCP hosted service endpoint
const MCP_HOSTED_URL = 'https://dashboard.n8n-mcp.com/api';

// Alternative: local n8n-mcp via HTTP
// Can be configured via environment variable
const MCP_LOCAL_URL = process.env.N8N_MCP_URL || null;

interface NodeDocumentation {
  name: string;
  displayName: string;
  description: string;
  properties?: Record<string, unknown>[];
  operations?: string[];
  examples?: string[];
  documentation?: string;
}

interface McpToolResponse {
  content: Array<{
    type: string;
    text: string;
  }>;
}

export class McpService {
  private baseUrl: string | null;
  private enabled: boolean;

  constructor() {
    this.baseUrl = MCP_LOCAL_URL || MCP_HOSTED_URL;
    this.enabled = true;

    logger.info('MCP service initialized', {
      url: this.baseUrl,
      mode: MCP_LOCAL_URL ? 'local' : 'hosted'
    });
  }

  async getNodeDocumentation(nodeType: string): Promise<NodeDocumentation | null> {
    if (!this.enabled) {
      return null;
    }

    try {
      // Extract the node name from full type (e.g., "n8n-nodes-base.httpRequest" -> "httpRequest")
      const nodeName = nodeType.split('.').pop() || nodeType;

      logger.info('Fetching node documentation from MCP', { nodeType, nodeName });

      // Try to get node properties and documentation
      const response = await axios.post<McpToolResponse>(
        `${this.baseUrl}/mcp`,
        {
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: {
            name: 'get_node',
            arguments: {
              name: nodeName,
              detail: 'full'
            }
          }
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      if (response.data?.content?.[0]?.text) {
        const docText = response.data.content[0].text;

        // Parse the response into structured documentation
        return this.parseNodeDocumentation(nodeName, docText);
      }

      return null;
    } catch (error) {
      logger.warn('Failed to fetch MCP node documentation', {
        nodeType,
        error: (error as Error).message
      });

      // Don't let MCP failures block the main flow
      return null;
    }
  }

  async searchNodes(query: string): Promise<string[]> {
    if (!this.enabled) {
      return [];
    }

    try {
      const response = await axios.post<McpToolResponse>(
        `${this.baseUrl}/mcp`,
        {
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: {
            name: 'search_nodes',
            arguments: {
              query,
              limit: 5
            }
          }
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );

      if (response.data?.content?.[0]?.text) {
        // Parse search results
        const results = response.data.content[0].text;
        const nodeNames = results.match(/\*\*(\w+)\*\*/g)?.map(m => m.replace(/\*\*/g, '')) || [];
        return nodeNames;
      }

      return [];
    } catch (error) {
      logger.warn('Failed to search MCP nodes', { query, error: (error as Error).message });
      return [];
    }
  }

  async getNodeExamples(nodeType: string): Promise<string[]> {
    if (!this.enabled) {
      return [];
    }

    try {
      const nodeName = nodeType.split('.').pop() || nodeType;

      const response = await axios.post<McpToolResponse>(
        `${this.baseUrl}/mcp`,
        {
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: {
            name: 'get_node_examples',
            arguments: {
              name: nodeName,
              limit: 3
            }
          }
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );

      if (response.data?.content?.[0]?.text) {
        // Return raw examples text - will be included in Claude prompt
        return [response.data.content[0].text];
      }

      return [];
    } catch (error) {
      logger.warn('Failed to fetch MCP node examples', { nodeType, error: (error as Error).message });
      return [];
    }
  }

  private parseNodeDocumentation(nodeName: string, rawText: string): NodeDocumentation {
    // Extract key information from the MCP response
    const doc: NodeDocumentation = {
      name: nodeName,
      displayName: nodeName,
      description: '',
      documentation: rawText.slice(0, 5000), // Limit size for prompt
    };

    // Try to extract description from the response
    const descMatch = rawText.match(/description[:\s]+([^\n]+)/i);
    if (descMatch) {
      doc.description = descMatch[1].trim();
    }

    // Try to extract operations
    const opsMatch = rawText.match(/operations?[:\s]+([^\n]+)/gi);
    if (opsMatch) {
      doc.operations = opsMatch.map(m => m.replace(/operations?[:\s]+/i, '').trim());
    }

    return doc;
  }

  // Allow disabling MCP if it's causing issues
  disable(): void {
    this.enabled = false;
    logger.warn('MCP service disabled');
  }

  enable(): void {
    this.enabled = true;
    logger.info('MCP service enabled');
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

// Singleton instance
export const mcpService = new McpService();
