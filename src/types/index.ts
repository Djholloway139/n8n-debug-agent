// Error payload received from n8n error workflow
export interface ErrorPayload {
  workflowId: string;
  workflowName?: string;
  executionId?: string;
  errorMessage: string;
  errorStack?: string;
  nodeName?: string;
  nodeType?: string;
  inputData?: unknown;
  timestamp?: string;
}

// Result returned after debug analysis
export interface DebugResult {
  success: boolean;
  approvalId?: string;
  analysis?: ErrorAnalysis;
  error?: string;
  message: string;
}

// Claude's analysis of the error
export interface ErrorAnalysis {
  rootCause: string;
  explanation: string;
  affectedNodes: string[];
  suggestedFix: FixProposal;
  confidence: 'high' | 'medium' | 'low';
  relatedSkills?: string[];
}

// Proposed fix for the workflow
export interface FixProposal {
  id: string;
  description: string;
  changes: WorkflowChange[];
  rollbackPossible: boolean;
}

// Individual change to apply to workflow
export interface WorkflowChange {
  nodeId?: string;
  nodeName?: string;
  changeType: 'modify_node' | 'add_node' | 'remove_node' | 'modify_connection' | 'modify_settings';
  path?: string;
  oldValue?: unknown;
  newValue: unknown;
  description: string;
}

// n8n Workflow structure (simplified)
export interface WorkflowData {
  id: string;
  name: string;
  active: boolean;
  nodes: WorkflowNode[];
  connections: Record<string, WorkflowConnections>;
  settings?: Record<string, unknown>;
}

export interface WorkflowNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, unknown>;
}

export interface WorkflowConnections {
  main: Array<Array<{ node: string; type: string; index: number }>>;
}

// n8n Execution details
export interface ExecutionData {
  id: string;
  finished: boolean;
  mode: string;
  startedAt: string;
  stoppedAt?: string;
  workflowId: string;
  workflowData: WorkflowData;
  data?: {
    resultData?: {
      runData?: Record<string, unknown>;
      error?: {
        message: string;
        stack?: string;
        node?: string;
      };
    };
  };
}

// Conversation message in suggestion flow
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

// Approval record stored in memory
export interface ApprovalRecord {
  id: string;
  workflowId: string;
  workflowName: string;
  executionId?: string;
  errorPayload: ErrorPayload;
  analysis: ErrorAnalysis;
  proposal: FixProposal;
  originalWorkflow: WorkflowData;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'applied';
  createdAt: Date;
  expiresAt: Date;
  slackMessageTs?: string;
  slackChannelId?: string;
  skills?: N8nSkill[];
  nodeDocumentation?: string;
  conversationHistory?: ConversationMessage[];
}

// n8n Skills from GitHub
export interface N8nSkill {
  name: string;
  description: string;
  content: string;
  nodeTypes?: string[];
  errorPatterns?: string[];
}

// Cache entry for skills
export interface SkillsCache {
  skills: N8nSkill[];
  fetchedAt: Date;
  expiresAt: Date;
}
