# n8n Debug Agent - Product Requirements Document

## Overview

An autonomous debugging agent that troubleshoots and fixes n8n workflow errors when triggered by an n8n error workflow. The agent uses Claude AI to analyze errors, propose fixes, and apply them after Slack-based approval.

## Problem Statement

When n8n workflows fail, debugging requires:
1. Manual inspection of error logs
2. Understanding the workflow structure
3. Identifying the root cause
4. Implementing and testing fixes

This is time-consuming and requires n8n expertise. An AI-powered debug agent can automate this process.

## Solution Architecture

```
┌─────────────────┐     HTTP Request      ┌──────────────────┐
│   n8n Error     │ ──────────────────►  │   Debug Agent    │
│   Workflow      │                       │   (Docker)       │
└─────────────────┘                       └────────┬─────────┘
                                                   │
                    ┌──────────────────────────────┼──────────────────────────────┐
                    │                              │                              │
                    ▼                              ▼                              ▼
           ┌────────────────┐            ┌─────────────────┐            ┌─────────────────┐
           │   Claude API   │            │   n8n API/MCP   │            │   n8n-skills    │
           │   (Analysis)   │            │   (Read/Write)  │            │   (GitHub)      │
           └────────────────┘            └─────────────────┘            └─────────────────┘
                    │
                    ▼
           ┌────────────────┐     Approve/Reject    ┌─────────────────┐
           │  Slack Message │ ◄──────────────────── │   User Review   │
           │  (Proposal)    │                       │                 │
           └────────────────┘                       └─────────────────┘
                    │
                    ▼ (on approval)
           ┌────────────────┐
           │  Apply Fix     │
           │  via n8n API   │
           └────────────────┘
```

## Technical Specifications

### Core Technology Stack

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Language | TypeScript/Node.js | Best n8n ecosystem integration |
| Runtime | Docker Container | Portable, consistent deployment |
| AI | Claude API (Anthropic) | Advanced reasoning for debugging |
| Approval | Slack Bot | Interactive approve/reject workflow |
| Config | Environment Variables | Standard, secure configuration |

### Key Integrations

1. **n8n MCP Server**: `https://workflows.rapiqual.com/mcp-server/http`
   - Authentication: API Key (X-N8N-API-KEY header)
   - Permissions: Workflow read/write only (no credentials)

2. **Claude API**: Direct HTTP calls to Anthropic API
   - Model: claude-sonnet-4-5-20250514 (enhanced reasoning for debugging)
   - Tool use enabled for structured analysis

3. **n8n-skills**: Dynamic fetching from GitHub
   - Repository: `czlonkowski/n8n-skills`
   - Fetched as context for Claude when analyzing errors

4. **Slack**: Existing bot with incoming webhooks
   - Interactive messages for approve/reject
   - Webhook callback for approval actions

### Data Flow

#### Input (from n8n Error Workflow)
```json
{
  "workflowId": "string",
  "executionId": "string",
  "errorNodeName": "string",
  "errorMessage": "string",
  "errorStack": "string",
  "inputData": {},
  "workflowName": "string",
  "timestamp": "ISO8601"
}
```

#### Output (to n8n for logging)
```json
{
  "status": "fixed|pending_approval|failed|no_fix_found",
  "analysis": "string",
  "proposedFix": {},
  "appliedFix": {},
  "approvalId": "string",
  "debugDuration": "number",
  "timestamp": "ISO8601"
}
```

## Functional Requirements

### FR1: Error Reception
- Expose HTTP endpoint for n8n error workflow to call
- Accept POST requests with error payload
- Validate incoming payload structure
- Queue errors if multiple arrive simultaneously

### FR2: Error Analysis
- Fetch full workflow JSON via n8n API
- Fetch relevant n8n-skills from GitHub for context
- Send error context to Claude API for analysis
- Parse Claude's structured response

### FR3: Fix Proposal
- Generate human-readable fix description
- Create specific workflow modifications (JSON diff)
- Send proposal to Slack with interactive buttons
- Store proposal state for callback handling

### FR4: Approval Workflow
- Handle Slack interactive message callbacks
- On approve: proceed to apply fix
- On reject: log rejection, notify n8n
- Timeout after configurable period (default: 24h)

### FR5: Fix Application
- Apply approved fixes via n8n API
- Validate fix was applied successfully
- Optionally trigger test execution
- Report results back to n8n

### FR6: Logging
- Return all debug results to n8n workflow
- Include analysis, proposal, and outcome
- Enable audit trail of all debug sessions

## Non-Functional Requirements

### NFR1: Security
- API keys stored as environment variables only
- No credential access in n8n (workflow-only permissions)
- HTTPS for all external communications
- Slack signature verification for callbacks

### NFR2: Reliability
- Graceful error handling (agent errors don't cascade)
- Retry logic for transient API failures
- Timeout handling for all external calls

### NFR3: Observability
- Structured logging (JSON format)
- Debug session tracking with unique IDs
- Duration metrics for each phase

### NFR4: Scalability
- Stateless design (state in n8n/external stores)
- Concurrent request handling
- Rate limiting for Claude API calls

## Project Structure

```
n8n-debug-agent/
├── src/
│   ├── index.ts              # Entry point, HTTP server
│   ├── routes/
│   │   ├── debug.ts          # POST /debug endpoint
│   │   └── slack.ts          # Slack callback handler
│   ├── services/
│   │   ├── claude.ts         # Claude API integration
│   │   ├── n8n.ts            # n8n API/MCP integration
│   │   ├── slack.ts          # Slack messaging
│   │   └── skills.ts         # n8n-skills fetcher
│   ├── analyzers/
│   │   ├── errorParser.ts    # Parse n8n error formats
│   │   └── fixGenerator.ts   # Generate fix proposals
│   ├── types/
│   │   └── index.ts          # TypeScript interfaces
│   └── utils/
│       ├── logger.ts         # Structured logging
│       └── config.ts         # Environment config
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── .env.example
├── CLAUDE.md                 # Claude Code context file
└── README.md
```

## Environment Variables

```env
# Required
ANTHROPIC_API_KEY=sk-ant-...
N8N_API_URL=https://workflows.rapiqual.com
N8N_API_KEY=your-n8n-api-key
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_CHANNEL_ID=C...

# Optional
PORT=3000
LOG_LEVEL=info
APPROVAL_TIMEOUT_HOURS=24
CLAUDE_MODEL=claude-sonnet-4-5-20250514
N8N_SKILLS_REPO=czlonkowski/n8n-skills
```

## n8n Error Workflow Setup

The n8n error workflow should be configured with:

1. **Error Trigger**: Set as error workflow for target workflows
2. **HTTP Request Node**: POST to debug agent endpoint
3. **Response Handler**: Process debug results for logging

```
[Error Trigger] → [HTTP Request to Agent] → [IF Status] → [Log/Notify]
```

## Milestones

### M1: Core Infrastructure
- Project scaffolding (TypeScript, Docker)
- HTTP server with /debug endpoint
- Environment configuration
- Basic logging

### M2: n8n Integration
- n8n API client
- Workflow fetching
- Fix application via API
- MCP server connectivity

### M3: Claude Integration
- Claude API client with tool use
- Error analysis prompt engineering
- Fix proposal generation
- n8n-skills dynamic fetching

### M4: Slack Approval Flow
- Slack message formatting
- Interactive message callbacks
- Approval state management
- Timeout handling

### M5: End-to-End Testing
- Integration tests
- Test error workflow in n8n
- Documentation
- CLAUDE.md file

## Success Criteria

1. Agent successfully receives errors from n8n error workflow
2. Agent correctly analyzes at least 80% of common error types
3. Proposed fixes are accurate and safe to apply
4. Slack approval flow works end-to-end
5. Fixes are applied correctly when approved
6. All results logged back to n8n

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Claude misdiagnoses error | Wrong fix applied | Require human approval via Slack |
| n8n API changes | Integration breaks | Use stable API versions, add error handling |
| Slack callback failures | Approvals lost | Timeout with notification, retry logic |
| Agent errors | Debug session fails | Comprehensive error handling, fallback responses |

## Future Enhancements (Out of Scope)

- Web UI for approval (alternative to Slack)
- Historical error pattern analysis
- Automatic fix learning from past approvals
- Multi-instance n8n support
- Credential error handling
