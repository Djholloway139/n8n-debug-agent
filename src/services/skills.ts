import axios from 'axios';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type { N8nSkill, SkillsCache } from '../types/index.js';

// Use the curated n8n-skills repo
const SKILLS_REPO_API = 'https://api.github.com/repos/czlonkowski/n8n-skills/contents/skills';
const RAW_CONTENT_BASE = 'https://raw.githubusercontent.com/czlonkowski/n8n-skills/main/skills';

let skillsCache: SkillsCache | null = null;

interface GitHubContent {
  name: string;
  path: string;
  type: 'file' | 'dir';
  download_url?: string;
}

// Map of skill names to relevant node types and error patterns
const SKILL_RELEVANCE: Record<string, { nodeTypes: string[]; errorPatterns: string[] }> = {
  'n8n-code-javascript': {
    nodeTypes: ['n8n-nodes-base.code', 'n8n-nodes-base.function', 'n8n-nodes-base.functionItem'],
    errorPatterns: ['javascript', 'script', 'syntax error', 'referenceerror', 'typeerror', 'undefined'],
  },
  'n8n-code-python': {
    nodeTypes: ['n8n-nodes-base.code'],
    errorPatterns: ['python', 'indentation', 'nameerror', 'attributeerror'],
  },
  'n8n-expression-syntax': {
    nodeTypes: [], // Applies to all nodes with expressions
    errorPatterns: ['expression', 'syntax', '{{', '}}', '$json', '$item', 'cannot read property'],
  },
  'n8n-mcp-tools-expert': {
    nodeTypes: ['n8n-nodes-base.mcp'],
    errorPatterns: ['mcp', 'tool', 'model context'],
  },
  'n8n-node-configuration': {
    nodeTypes: [], // Applies to all nodes
    errorPatterns: ['configuration', 'parameter', 'required', 'missing', 'invalid'],
  },
  'n8n-validation-expert': {
    nodeTypes: ['n8n-nodes-base.if', 'n8n-nodes-base.switch', 'n8n-nodes-base.filter'],
    errorPatterns: ['validation', 'invalid', 'type', 'format', 'schema'],
  },
  'n8n-workflow-patterns': {
    nodeTypes: [], // Applies to workflow-level issues
    errorPatterns: ['workflow', 'connection', 'loop', 'trigger', 'execution'],
  },
};

export class SkillsService {
  private cacheTtl: number;

  constructor() {
    this.cacheTtl = config.skillsCacheTtl;
  }

  async fetchSkills(): Promise<N8nSkill[]> {
    // Check cache first
    if (skillsCache && new Date() < skillsCache.expiresAt) {
      logger.debug('Returning cached skills', { count: skillsCache.skills.length });
      return skillsCache.skills;
    }

    logger.info('Fetching n8n skills from czlonkowski/n8n-skills repo');

    try {
      const skills: N8nSkill[] = [];

      // Fetch list of skill directories
      const response = await axios.get<GitHubContent[]>(SKILLS_REPO_API, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
        },
        timeout: 30000,
      });

      const skillDirs = response.data.filter((item) => item.type === 'dir');

      // Fetch each skill's content
      for (const dir of skillDirs) {
        try {
          const skill = await this.fetchSkill(dir.name);
          if (skill) {
            skills.push(skill);
          }
        } catch (error) {
          logger.debug('Failed to fetch skill', { skill: dir.name, error: (error as Error).message });
        }
      }

      // Update cache
      const now = new Date();
      skillsCache = {
        skills,
        fetchedAt: now,
        expiresAt: new Date(now.getTime() + this.cacheTtl),
      };

      logger.info('Skills fetched and cached', { count: skills.length });
      return skills;
    } catch (error) {
      logger.error('Failed to fetch skills', { error: (error as Error).message });

      // Return cached skills even if expired, or empty array
      if (skillsCache) {
        logger.warn('Returning expired cached skills');
        return skillsCache.skills;
      }

      return [];
    }
  }

  private async fetchSkill(skillName: string): Promise<N8nSkill | null> {
    try {
      // Fetch the main SKILL.md file
      const skillUrl = `${RAW_CONTENT_BASE}/${skillName}/SKILL.md`;
      const skillResponse = await axios.get<string>(skillUrl, { timeout: 10000 });
      const skillContent = skillResponse.data;

      // Also try to fetch README.md for description
      let description = '';
      try {
        const readmeUrl = `${RAW_CONTENT_BASE}/${skillName}/README.md`;
        const readmeResponse = await axios.get<string>(readmeUrl, { timeout: 10000 });
        // Extract first paragraph as description
        const firstPara = readmeResponse.data.split('\n\n')[1] || readmeResponse.data.split('\n')[0];
        description = firstPara.replace(/^#+\s*/, '').slice(0, 200);
      } catch {
        // Use skill name as description if README fails
        description = `n8n skill: ${skillName.replace(/-/g, ' ')}`;
      }

      // Get relevance mapping
      const relevance = SKILL_RELEVANCE[skillName] || { nodeTypes: [], errorPatterns: [] };

      return {
        name: skillName,
        description,
        content: skillContent,
        nodeTypes: relevance.nodeTypes,
        errorPatterns: relevance.errorPatterns,
      };
    } catch {
      return null;
    }
  }

  filterSkillsForError(skills: N8nSkill[], nodeType?: string, errorMessage?: string): N8nSkill[] {
    if (!nodeType && !errorMessage) {
      // Return most generally useful skills
      const prioritySkills = ['n8n-node-configuration', 'n8n-expression-syntax', 'n8n-workflow-patterns'];
      return skills.filter((s) => prioritySkills.includes(s.name)).slice(0, 3);
    }

    const scoredSkills: Array<N8nSkill & { score: number }> = [];
    const errorLower = errorMessage?.toLowerCase() || '';
    const nodeTypeLower = nodeType?.toLowerCase() || '';

    for (const skill of skills) {
      let score = 0;

      // Check node type match
      if (nodeType && skill.nodeTypes) {
        for (const nt of skill.nodeTypes) {
          if (nodeTypeLower.includes(nt.toLowerCase().split('.').pop() || '')) {
            score += 10;
            break;
          }
        }
      }

      // Check error pattern match
      if (errorMessage && skill.errorPatterns) {
        for (const pattern of skill.errorPatterns) {
          if (errorLower.includes(pattern.toLowerCase())) {
            score += 5;
          }
        }
      }

      // Check skill name relevance
      const skillNameWords = skill.name.split('-').filter((w) => w !== 'n8n');
      for (const word of skillNameWords) {
        if (errorLower.includes(word) || nodeTypeLower.includes(word)) {
          score += 2;
        }
      }

      // Always include node-configuration as it's generally useful
      if (skill.name === 'n8n-node-configuration' && score === 0) {
        score = 1;
      }

      if (score > 0) {
        scoredSkills.push({ ...skill, score });
      }
    }

    // Sort by score and return top results
    return scoredSkills
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }

  clearCache(): void {
    skillsCache = null;
    logger.info('Skills cache cleared');
  }
}

// Singleton instance
export const skillsService = new SkillsService();
