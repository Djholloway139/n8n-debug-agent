import axios from 'axios';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type { N8nSkill, SkillsCache } from '../types/index.js';

const SKILLS_REPO_URL = 'https://api.github.com/repos/n8n-io/n8n-docs/contents/docs/integrations/builtin';
const RAW_CONTENT_BASE = 'https://raw.githubusercontent.com/n8n-io/n8n-docs/main/docs/integrations/builtin';

// Alternative: n8n-skills repository if it exists
const N8N_SKILLS_REPO = 'https://api.github.com/repos/n8n-io/n8n/contents/packages/nodes-base/nodes';

let skillsCache: SkillsCache | null = null;

interface GitHubContent {
  name: string;
  path: string;
  type: 'file' | 'dir';
  download_url?: string;
}

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

    logger.info('Fetching n8n skills from GitHub');

    try {
      const skills: N8nSkill[] = [];

      // Fetch core node documentation
      const coreNodes = await this.fetchNodeDocs('core-nodes');
      skills.push(...coreNodes);

      // Fetch app nodes documentation
      const appNodes = await this.fetchNodeDocs('app-nodes');
      skills.push(...appNodes);

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

  private async fetchNodeDocs(category: string): Promise<N8nSkill[]> {
    const skills: N8nSkill[] = [];

    try {
      const response = await axios.get<GitHubContent[]>(`${SKILLS_REPO_URL}/${category}`, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
        },
        timeout: 30000,
      });

      const directories = response.data.filter((item) => item.type === 'dir');

      // Fetch content for each node (limit to avoid rate limiting)
      const limitedDirs = directories.slice(0, 50);

      for (const dir of limitedDirs) {
        try {
          const skill = await this.fetchNodeSkill(category, dir.name);
          if (skill) {
            skills.push(skill);
          }
        } catch {
          // Skip individual failures
          logger.debug('Failed to fetch skill', { node: dir.name });
        }
      }
    } catch (error) {
      logger.warn(`Failed to fetch ${category} docs`, { error: (error as Error).message });
    }

    return skills;
  }

  private async fetchNodeSkill(category: string, nodeName: string): Promise<N8nSkill | null> {
    try {
      // Try to fetch the index.md or common operations file
      const indexUrl = `${RAW_CONTENT_BASE}/${category}/${nodeName}/index.md`;

      const response = await axios.get<string>(indexUrl, {
        timeout: 10000,
      });

      const content = response.data;

      // Extract description from markdown
      const descriptionMatch = content.match(/description:\s*(.+)/);
      const description = descriptionMatch ? descriptionMatch[1].trim() : `${nodeName} node documentation`;

      return {
        name: nodeName,
        description,
        content: content.slice(0, 5000), // Limit content size
        nodeTypes: [this.normalizeNodeType(nodeName)],
        errorPatterns: this.extractErrorPatterns(content),
      };
    } catch {
      return null;
    }
  }

  private normalizeNodeType(nodeName: string): string {
    // Convert directory name to n8n node type format
    // e.g., "http-request" -> "n8n-nodes-base.httpRequest"
    const camelCase = nodeName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    return `n8n-nodes-base.${camelCase}`;
  }

  private extractErrorPatterns(content: string): string[] {
    const patterns: string[] = [];

    // Look for common error-related sections
    const errorSections = content.match(/(?:error|troubleshoot|common issues)[^\n]*\n([\s\S]*?)(?=\n##|\n$)/gi);

    if (errorSections) {
      for (const section of errorSections) {
        // Extract bullet points or error messages
        const bullets = section.match(/[-*]\s*(.+)/g);
        if (bullets) {
          patterns.push(...bullets.map((b) => b.replace(/^[-*]\s*/, '')));
        }
      }
    }

    return patterns.slice(0, 10); // Limit patterns
  }

  filterSkillsForError(skills: N8nSkill[], nodeType?: string, errorMessage?: string): N8nSkill[] {
    if (!nodeType && !errorMessage) {
      return skills.slice(0, 5); // Return top 5 general skills
    }

    const relevantSkills: N8nSkill[] = [];

    for (const skill of skills) {
      let score = 0;

      // Check if node type matches
      if (nodeType && skill.nodeTypes?.some((nt) => nodeType.toLowerCase().includes(nt.toLowerCase().split('.').pop() || ''))) {
        score += 10;
      }

      // Check if skill name matches node type
      if (nodeType && nodeType.toLowerCase().includes(skill.name.toLowerCase().replace(/-/g, ''))) {
        score += 5;
      }

      // Check error patterns
      if (errorMessage && skill.errorPatterns) {
        for (const pattern of skill.errorPatterns) {
          if (errorMessage.toLowerCase().includes(pattern.toLowerCase())) {
            score += 3;
          }
        }
      }

      // Check content for error message keywords
      if (errorMessage) {
        const keywords = errorMessage.split(/\s+/).filter((w) => w.length > 4);
        for (const keyword of keywords.slice(0, 5)) {
          if (skill.content.toLowerCase().includes(keyword.toLowerCase())) {
            score += 1;
          }
        }
      }

      if (score > 0) {
        relevantSkills.push({ ...skill, score } as N8nSkill & { score: number });
      }
    }

    // Sort by score and return top results
    return relevantSkills
      .sort((a, b) => ((b as N8nSkill & { score: number }).score || 0) - ((a as N8nSkill & { score: number }).score || 0))
      .slice(0, 5);
  }

  clearCache(): void {
    skillsCache = null;
    logger.info('Skills cache cleared');
  }
}

// Singleton instance
export const skillsService = new SkillsService();
