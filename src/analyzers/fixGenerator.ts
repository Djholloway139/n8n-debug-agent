import { logger } from '../utils/logger.js';
import type { ErrorAnalysis, WorkflowData, WorkflowChange, WorkflowNode } from '../types/index.js';

export interface PatchResult {
  success: boolean;
  patchedWorkflow?: WorkflowData;
  error?: string;
  appliedChanges: string[];
  skippedChanges: string[];
}

export function applyFix(workflow: WorkflowData, analysis: ErrorAnalysis): PatchResult {
  const appliedChanges: string[] = [];
  const skippedChanges: string[] = [];

  // Deep clone the workflow to avoid mutations
  const patchedWorkflow: WorkflowData = JSON.parse(JSON.stringify(workflow));

  for (const change of analysis.suggestedFix.changes) {
    try {
      const result = applyChange(patchedWorkflow, change);
      if (result.success) {
        appliedChanges.push(change.description);
      } else {
        skippedChanges.push(`${change.description}: ${result.error}`);
      }
    } catch (error) {
      skippedChanges.push(`${change.description}: ${(error as Error).message}`);
      logger.warn('Failed to apply change', {
        change: change.description,
        error: (error as Error).message,
      });
    }
  }

  if (appliedChanges.length === 0) {
    return {
      success: false,
      error: 'No changes could be applied',
      appliedChanges,
      skippedChanges,
    };
  }

  // Validate the patched workflow
  const validationResult = validateWorkflow(patchedWorkflow);
  if (!validationResult.valid) {
    return {
      success: false,
      error: `Validation failed: ${validationResult.errors.join(', ')}`,
      appliedChanges,
      skippedChanges,
    };
  }

  logger.info('Fix applied successfully', {
    applied: appliedChanges.length,
    skipped: skippedChanges.length,
  });

  return {
    success: true,
    patchedWorkflow,
    appliedChanges,
    skippedChanges,
  };
}

interface ChangeResult {
  success: boolean;
  error?: string;
}

function applyChange(workflow: WorkflowData, change: WorkflowChange): ChangeResult {
  switch (change.changeType) {
    case 'modify_node':
      return modifyNode(workflow, change);
    case 'add_node':
      return addNode(workflow, change);
    case 'remove_node':
      return removeNode(workflow, change);
    case 'modify_connection':
      return modifyConnection(workflow, change);
    case 'modify_settings':
      return modifySettings(workflow, change);
    default:
      return { success: false, error: `Unknown change type: ${change.changeType}` };
  }
}

function modifyNode(workflow: WorkflowData, change: WorkflowChange): ChangeResult {
  const nodeName = change.nodeName;
  if (!nodeName) {
    return { success: false, error: 'Node name required for modify_node' };
  }

  const nodeIndex = workflow.nodes.findIndex((n) => n.name === nodeName);
  if (nodeIndex === -1) {
    return { success: false, error: `Node not found: ${nodeName}` };
  }

  const node = workflow.nodes[nodeIndex];

  if (change.path) {
    // Apply change at specific path
    const pathParts = change.path.split('.');
    let target: Record<string, unknown> = node as unknown as Record<string, unknown>;

    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i];
      if (target[part] === undefined) {
        target[part] = {};
      }
      target = target[part] as Record<string, unknown>;
    }

    const lastPart = pathParts[pathParts.length - 1];
    target[lastPart] = change.newValue;
  } else if (typeof change.newValue === 'object' && change.newValue !== null) {
    // Merge new values into node
    Object.assign(node, change.newValue);
  } else {
    return { success: false, error: 'Invalid change value for modify_node' };
  }

  return { success: true };
}

function addNode(workflow: WorkflowData, change: WorkflowChange): ChangeResult {
  const newNode = change.newValue as WorkflowNode;

  if (!newNode || !newNode.name || !newNode.type) {
    return { success: false, error: 'Invalid node definition for add_node' };
  }

  // Check if node name already exists
  if (workflow.nodes.some((n) => n.name === newNode.name)) {
    return { success: false, error: `Node already exists: ${newNode.name}` };
  }

  // Ensure required fields
  const nodeToAdd: WorkflowNode = {
    id: newNode.id || generateNodeId(),
    name: newNode.name,
    type: newNode.type,
    typeVersion: newNode.typeVersion || 1,
    position: newNode.position || calculatePosition(workflow),
    parameters: newNode.parameters || {},
  };

  workflow.nodes.push(nodeToAdd);
  return { success: true };
}

function removeNode(workflow: WorkflowData, change: WorkflowChange): ChangeResult {
  const nodeName = change.nodeName;
  if (!nodeName) {
    return { success: false, error: 'Node name required for remove_node' };
  }

  const nodeIndex = workflow.nodes.findIndex((n) => n.name === nodeName);
  if (nodeIndex === -1) {
    return { success: false, error: `Node not found: ${nodeName}` };
  }

  // Remove the node
  workflow.nodes.splice(nodeIndex, 1);

  // Remove connections to/from this node
  delete workflow.connections[nodeName];
  for (const connections of Object.values(workflow.connections)) {
    if (connections.main) {
      for (const outputs of connections.main) {
        const filteredOutputs = outputs.filter((o) => o.node !== nodeName);
        outputs.length = 0;
        outputs.push(...filteredOutputs);
      }
    }
  }

  return { success: true };
}

function modifyConnection(workflow: WorkflowData, change: WorkflowChange): ChangeResult {
  const connectionChange = change.newValue as {
    from: string;
    to: string;
    action: 'add' | 'remove';
    outputIndex?: number;
    inputIndex?: number;
  };

  if (!connectionChange || !connectionChange.from || !connectionChange.to) {
    return { success: false, error: 'Invalid connection change' };
  }

  const { from, to, action, outputIndex = 0, inputIndex = 0 } = connectionChange;

  // Verify nodes exist
  if (!workflow.nodes.some((n) => n.name === from)) {
    return { success: false, error: `Source node not found: ${from}` };
  }
  if (!workflow.nodes.some((n) => n.name === to)) {
    return { success: false, error: `Target node not found: ${to}` };
  }

  if (action === 'add') {
    if (!workflow.connections[from]) {
      workflow.connections[from] = { main: [[]] };
    }
    while (workflow.connections[from].main.length <= outputIndex) {
      workflow.connections[from].main.push([]);
    }
    workflow.connections[from].main[outputIndex].push({
      node: to,
      type: 'main',
      index: inputIndex,
    });
  } else if (action === 'remove') {
    if (workflow.connections[from]?.main?.[outputIndex]) {
      const connections = workflow.connections[from].main[outputIndex];
      const idx = connections.findIndex((c) => c.node === to);
      if (idx !== -1) {
        connections.splice(idx, 1);
      }
    }
  }

  return { success: true };
}

function modifySettings(workflow: WorkflowData, change: WorkflowChange): ChangeResult {
  if (!workflow.settings) {
    workflow.settings = {};
  }

  if (change.path) {
    const pathParts = change.path.split('.');
    let target = workflow.settings;

    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i];
      if (target[part] === undefined) {
        target[part] = {};
      }
      target = target[part] as Record<string, unknown>;
    }

    const lastPart = pathParts[pathParts.length - 1];
    target[lastPart] = change.newValue;
  } else if (typeof change.newValue === 'object' && change.newValue !== null) {
    Object.assign(workflow.settings, change.newValue);
  }

  return { success: true };
}

function generateNodeId(): string {
  return `node-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function calculatePosition(workflow: WorkflowData): [number, number] {
  if (workflow.nodes.length === 0) {
    return [250, 300];
  }

  // Find the rightmost position and add offset
  let maxX = 0;
  let avgY = 0;

  for (const node of workflow.nodes) {
    if (node.position[0] > maxX) {
      maxX = node.position[0];
    }
    avgY += node.position[1];
  }

  avgY = Math.round(avgY / workflow.nodes.length);

  return [maxX + 200, avgY];
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function validateWorkflow(workflow: WorkflowData): ValidationResult {
  const errors: string[] = [];

  // Check required fields
  if (!workflow.id) {
    errors.push('Workflow ID is missing');
  }

  if (!workflow.name) {
    errors.push('Workflow name is missing');
  }

  if (!Array.isArray(workflow.nodes)) {
    errors.push('Nodes array is invalid');
    return { valid: false, errors };
  }

  // Check for duplicate node names
  const nodeNames = new Set<string>();
  for (const node of workflow.nodes) {
    if (!node.name) {
      errors.push('Node with missing name found');
      continue;
    }
    if (nodeNames.has(node.name)) {
      errors.push(`Duplicate node name: ${node.name}`);
    }
    nodeNames.add(node.name);

    if (!node.type) {
      errors.push(`Node ${node.name} is missing type`);
    }
  }

  // Validate connections reference existing nodes
  for (const [sourceName, connections] of Object.entries(workflow.connections)) {
    if (!nodeNames.has(sourceName)) {
      errors.push(`Connection from non-existent node: ${sourceName}`);
    }

    if (connections.main) {
      for (const outputs of connections.main) {
        for (const output of outputs) {
          if (!nodeNames.has(output.node)) {
            errors.push(`Connection to non-existent node: ${output.node}`);
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function generatePatchDescription(analysis: ErrorAnalysis): string {
  const parts: string[] = [];

  parts.push(`Fix for: ${analysis.rootCause}`);
  parts.push('');
  parts.push('Changes:');

  for (const change of analysis.suggestedFix.changes) {
    parts.push(`- ${change.description}`);
  }

  if (analysis.relatedSkills && analysis.relatedSkills.length > 0) {
    parts.push('');
    parts.push(`Reference: ${analysis.relatedSkills.join(', ')}`);
  }

  return parts.join('\n');
}
