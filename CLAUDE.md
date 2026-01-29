# n8n Debug Agent

## Project Purpose
Autonomous n8n workflow debugging agent that:
1. Receives errors from n8n error workflows via HTTP webhook
2. Analyzes errors using Claude API with n8n documentation context
3. Proposes fixes via Slack with interactive approval workflow
4. Supports iterative conversation - user can suggest alternative fixes
5. Applies approved fixes to n8n workflows via API

## Current Status: DEPLOYED & FUNCTIONAL
- **Live URL:** https://agents.rapiqual.com
- **Health Check:** https://agents.rapiqual.com/health
- **GitHub Repo:** https://github.com/Djholloway139/n8n-debug-agent
- **Hosted on:** Hostinger VPS (72.61.18.201) via Docker + Traefik

## Architecture

```
┌─────────────────┐     ┌─────────────────────────┐     ┌──────────────┐
│  n8n Error      │────▶│  n8n Debug Agent        │────▶│  Slack       │
│  Workflow       │     │  (Docker Container)     │     │  Channel     │
│                 │     │                         │     │              │
│  POST /debug    │     │  ┌─────────────────┐   │     │  [Approve]   │
│  + Bearer Token │     │  │  Claude API     │   │     │  [Suggest]   │
└─────────────────┘     │  │  Analysis       │   │     │  [Reject]    │
                        │  └─────────────────┘   │     └──────┬───────┘
                        │                         │            │
                        │  ┌─────────────────┐   │◀───────────┘
                        │  │  Apply Fix      │───┼────▶ n8n API
                        │  │  (on approval)  │   │     PATCH workflow
                        │  └─────────────────┘   │
                        └─────────────────────────┘
```

## Key Features Implemented

### 1. Error Analysis
- Receives error payloads from n8n error workflows
- Fetches workflow JSON from n8n API
- Fetches relevant n8n documentation from GitHub (cached 1 hour)
- Analyzes with Claude to identify root cause and propose fix

### 2. Slack Approval Workflow
- Posts interactive message with error analysis and proposed fix
- Three action buttons: Approve & Apply, Suggest Fix, Reject
- **Suggest Fix** opens a modal for user feedback
- Iterative conversation - user can refine fix multiple times
- Revised proposals posted in thread with same action buttons

### 3. Workflow Updates
- Applies fixes via n8n PUT API
- **CRITICAL:** Preserves original credentials (credentials are not modified)
- Validates patches before applying
- Posts success/failure status to Slack thread

## File Structure

```
src/
├── index.ts                    # Express server entry point
├── types/index.ts              # TypeScript interfaces
├── middleware/
│   └── auth.ts                 # Bearer token authentication
├── utils/
│   ├── config.ts               # Environment configuration
│   └── logger.ts               # Winston JSON logging
├── services/
│   ├── n8n.ts                  # n8n API client (GET/PUT workflows)
│   ├── claude.ts               # Claude API (analyzeError, reviseFix)
│   ├── slack.ts                # Slack messaging, modals, threads
│   ├── skills.ts               # n8n docs fetcher with caching
│   └── approvalStore.ts        # In-memory approval tracking (TTL 24h)
├── routes/
│   ├── debug.ts                # POST /debug - main entry point
│   └── slack.ts                # POST /slack/actions - button/modal handlers
└── analyzers/
    ├── errorParser.ts          # Error categorization
    └── fixGenerator.ts         # Workflow patch generation & validation
```

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | None | Health check |
| `/debug` | POST | Bearer | Receive error, analyze, propose fix |
| `/debug/approval/:id` | GET | Bearer | Get approval status |
| `/debug/approvals` | GET | Bearer | List pending approvals |
| `/slack/actions` | POST | Slack Signature | Handle button clicks & modal submissions |

## Environment Variables

```bash
# Server
PORT=3000
NODE_ENV=production
LOG_LEVEL=info

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# n8n API
N8N_API_URL=https://workflows.rapiqual.com/api/v1
N8N_API_KEY=eyJ...

# Slack (dedicated "n8n Debug Agent" app)
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_CHANNEL_ID=C09GXR66QFJ

# API Security
API_BEARER_TOKEN=125fddeeef17a12388fd7ac7050a153e43e1420cf36f47b2536613af781aa05d
```

## Deployment

### VPS Location
- Path: `/home/n8n-debug-agent`
- Network: `root_default` (shared with n8n + Traefik)
- Domain: `agents.rapiqual.com` (Traefik SSL)

### Deploy Commands
```bash
cd /home/n8n-debug-agent
git pull
docker compose -f docker-compose.traefik.yml up -d --build
docker logs -f n8n-debug-agent  # Watch logs
```

### Docker Compose (Traefik)
```yaml
services:
  n8n-debug-agent:
    build: .
    container_name: n8n-debug-agent
    restart: unless-stopped
    env_file:
      - .env
    networks:
      - root_default
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.n8n-debug-agent.rule=Host(`agents.rapiqual.com`)"
      - "traefik.http.routers.n8n-debug-agent.entrypoints=websecure"
      - "traefik.http.routers.n8n-debug-agent.tls.certresolver=mytlschallenge"
      - "traefik.http.services.n8n-debug-agent.loadbalancer.server.port=3000"

networks:
  root_default:
    external: true
```

## n8n Error Workflow Configuration

In n8n, create an Error Workflow with an HTTP Request node:

- **URL:** `https://agents.rapiqual.com/debug`
- **Method:** POST
- **Authentication:** Header Auth
  - Name: `Authorization`
  - Value: `Bearer 125fddeeef17a12388fd7ac7050a153e43e1420cf36f47b2536613af781aa05d`
- **Body:** JSON with expressions mapping error data

## Known Issues & Fixes Applied

### 1. Credential Preservation (CRITICAL)
- **Issue:** n8n API can break credential references when updating workflows
- **Fix:** `updateWorkflow()` in n8n.ts preserves original credentials from each node
- **Code:** Passes `originalWorkflow` to compare and keep credential references intact

### 2. Slack Signature Verification
- **Issue:** Slack sends button clicks as form-urlencoded, not JSON
- **Fix:** Raw body capture added to both `express.json()` and `express.urlencoded()`

### 3. n8n API Method
- **Issue:** n8n requires PUT (not PATCH) for workflow updates
- **Fix:** Changed `client.patch()` to `client.put()` in n8n.ts

## Potential Next Steps

### High Priority
1. **Better error response logging** - Capture full n8n API error responses for debugging
2. **Rollback functionality** - Store original workflow state and allow reverting
3. **Test mode** - Dry-run fixes without actually applying them

### Medium Priority
4. **Multiple workflow support** - Handle errors from multiple workflows in parallel
5. **Execution context** - Fetch execution data to see actual input/output at error point
6. **Fix history** - Track all fixes applied to each workflow over time

### Nice to Have
7. **Dashboard** - Web UI to view pending approvals and fix history
8. **Metrics** - Track success rate, time to fix, common error types
9. **Auto-fix patterns** - Learn from approved fixes to auto-suggest common patterns
10. **Integration with more channels** - Discord, email notifications

## Commands Reference

```bash
# Local development
npm run dev          # Start with hot reload
npm run build        # Compile TypeScript
npm run typecheck    # Type checking only

# Docker
docker build -t n8n-debug-agent .
docker compose -f docker-compose.traefik.yml up -d --build
docker logs -f n8n-debug-agent

# Test endpoints
curl https://agents.rapiqual.com/health
curl -X POST https://agents.rapiqual.com/debug \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"workflowId":"xxx","errorMessage":"test"}'
```

## Slack App Configuration

A dedicated Slack app "n8n Debug Agent" is configured with:
- **OAuth Scopes:** chat:write, chat:write.public
- **Interactivity Request URL:** https://agents.rapiqual.com/slack/actions
- **Bot added to channel:** C09GXR66QFJ

## Dependencies

```json
{
  "@anthropic-ai/sdk": "^0.24.0",
  "@slack/bolt": "^3.17.0",
  "axios": "^1.6.0",
  "dotenv": "^16.3.1",
  "express": "^4.18.2",
  "uuid": "^9.0.0",
  "winston": "^3.11.0"
}
```
