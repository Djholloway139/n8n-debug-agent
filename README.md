# n8n Debug Agent

An autonomous debugging agent for n8n workflows. When a workflow fails, this agent analyzes the error using Claude AI, proposes a fix, and applies it after human approval via Slack.

## Features

- **Automatic Error Analysis**: Receives errors from n8n error workflows and analyzes them using Claude AI
- **Context-Aware**: Fetches relevant n8n documentation to provide informed fixes
- **Human-in-the-Loop**: All fixes require approval via Slack before being applied
- **Safe Operations**: Creates patches without modifying credentials, with rollback support

## Prerequisites

- Node.js 20+
- Docker (optional, for containerized deployment)
- n8n instance with API access
- Anthropic API key
- Slack workspace with a bot configured

## Quick Start

1. **Clone and install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

3. **Start the server**
   ```bash
   npm run dev
   ```

4. **Configure n8n error workflow**

   Create an error workflow in n8n that sends errors to this agent:
   ```json
   {
     "nodes": [
       {
         "name": "Error Trigger",
         "type": "n8n-nodes-base.errorTrigger"
       },
       {
         "name": "Send to Debug Agent",
         "type": "n8n-nodes-base.httpRequest",
         "parameters": {
           "method": "POST",
           "url": "http://your-agent-host:3000/debug",
           "body": {
             "workflowId": "={{ $json.workflow.id }}",
             "workflowName": "={{ $json.workflow.name }}",
             "executionId": "={{ $json.execution.id }}",
             "errorMessage": "={{ $json.execution.error.message }}",
             "nodeName": "={{ $json.execution.error.node?.name }}"
           }
         }
       }
     ]
   }
   ```

## Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Server port (default: 3000) | No |
| `NODE_ENV` | Environment (development/production) | No |
| `LOG_LEVEL` | Logging level (debug/info/warn/error) | No |
| `ANTHROPIC_API_KEY` | Claude API key | Yes |
| `N8N_API_URL` | n8n API base URL | Yes |
| `N8N_API_KEY` | n8n API key | Yes |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token | Yes |
| `SLACK_SIGNING_SECRET` | Slack app signing secret | Yes |
| `SLACK_CHANNEL_ID` | Channel for fix proposals | Yes |
| `SKILLS_CACHE_TTL` | Cache TTL in ms (default: 3600000) | No |

## Slack App Setup

1. Create a new Slack app at https://api.slack.com/apps
2. Add the following OAuth scopes:
   - `chat:write`
   - `chat:write.public`
3. Enable Interactivity and set the request URL to: `https://your-host/slack/actions`
4. Install the app to your workspace
5. Copy the Bot Token and Signing Secret to your `.env`

## API Endpoints

### POST /debug
Receive and process an error from n8n.

**Request:**
```json
{
  "workflowId": "abc123",
  "workflowName": "My Workflow",
  "executionId": "exec-456",
  "errorMessage": "Cannot read property 'x' of undefined",
  "errorStack": "...",
  "nodeName": "HTTP Request",
  "nodeType": "n8n-nodes-base.httpRequest"
}
```

**Response:**
```json
{
  "success": true,
  "approvalId": "uuid",
  "analysis": {
    "rootCause": "...",
    "explanation": "...",
    "suggestedFix": {...}
  },
  "message": "Error analyzed and fix proposed. Awaiting approval in Slack."
}
```

### GET /debug/approval/:id
Get the status of a specific approval.

### GET /debug/approvals
List all pending approvals.

### GET /health
Health check endpoint.

## Docker Deployment

```bash
# Build
docker build -t n8n-debug-agent .

# Run
docker run -p 3000:3000 --env-file .env n8n-debug-agent

# Or use docker-compose
docker-compose up -d
```

## Architecture

```
┌─────────────┐     ┌───────────────────┐     ┌─────────┐
│  n8n Error  │────▶│  n8n Debug Agent  │────▶│  Slack  │
│  Workflow   │     │                   │     │         │
└─────────────┘     │  ┌─────────────┐  │     └────┬────┘
                    │  │   Claude    │  │          │
                    │  │   Analysis  │  │     Approve/Reject
                    │  └─────────────┘  │          │
                    │                   │◀─────────┘
                    │  ┌─────────────┐  │
                    │  │  Apply Fix  │──┼────▶ n8n API
                    │  └─────────────┘  │
                    └───────────────────┘
```

## Development

```bash
# Start with hot reload
npm run dev

# Type check
npm run typecheck

# Build for production
npm run build

# Run production build
npm start
```

## License

MIT
