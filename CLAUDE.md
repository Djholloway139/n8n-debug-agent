# n8n Debug Agent

## Project Purpose
Autonomous n8n workflow debugging agent triggered by error workflows. Receives errors from n8n, analyzes them using Claude API with n8n documentation context, proposes fixes via Slack for approval, and applies approved fixes to n8n workflows.

## Architecture
- TypeScript/Express HTTP server
- Claude API for error analysis
- n8n API for workflow operations
- Slack for approval workflow
- In-memory approval store with TTL-based expiration

## Key Commands
- `npm run dev`: Start development server with hot reload
- `npm run build`: Compile TypeScript to JavaScript
- `npm run start`: Run production build
- `npm run typecheck`: Run TypeScript type checking
- `docker build -t n8n-debug-agent .`: Build Docker image
- `docker-compose up`: Run in Docker

## Environment Setup
Copy `.env.example` to `.env` and fill in:
- `ANTHROPIC_API_KEY`: Claude API key
- `N8N_API_URL`: n8n API base URL (e.g., https://workflows.rapiqual.com/api/v1)
- `N8N_API_KEY`: n8n API key
- `SLACK_BOT_TOKEN`: Slack bot token (xoxb-...)
- `SLACK_SIGNING_SECRET`: Slack signing secret for verifying requests
- `SLACK_CHANNEL_ID`: Channel ID for posting fix proposals

## Code Patterns
- Services are classes with singleton exports
- All external API calls have retry logic with exponential backoff
- Structured JSON logging throughout using Winston
- TypeScript strict mode enabled
- ESM modules (type: module in package.json)
- Request IDs for tracing across logs

## n8n Integration
- API Base URL: Configured via N8N_API_URL environment variable
- Auth: X-N8N-API-KEY header
- Endpoints used: GET/PATCH /workflows/{id}, GET /executions/{id}

## File Structure
```
src/
├── index.ts              # Express server entry point
├── types/index.ts        # TypeScript interfaces
├── utils/
│   ├── config.ts         # Environment configuration
│   └── logger.ts         # Winston logger setup
├── services/
│   ├── n8n.ts            # n8n API client
│   ├── claude.ts         # Claude API integration
│   ├── slack.ts          # Slack messaging
│   ├── skills.ts         # n8n documentation fetcher
│   └── approvalStore.ts  # In-memory approval storage
├── routes/
│   ├── debug.ts          # POST /debug endpoint
│   └── slack.ts          # Slack action handler
└── analyzers/
    ├── errorParser.ts    # Error categorization
    └── fixGenerator.ts   # Workflow patch generator
```

## API Endpoints
- `POST /debug`: Receive error from n8n, analyze, and propose fix
- `GET /debug/approval/:id`: Get status of an approval
- `GET /debug/approvals`: List pending approvals
- `POST /slack/actions`: Handle Slack button clicks
- `GET /health`: Health check

## Testing
1. Start the server: `npm run dev`
2. Send a test error:
   ```bash
   curl -X POST http://localhost:3000/debug \
     -H "Content-Type: application/json" \
     -d '{"workflowId":"test-id","errorMessage":"Test error message"}'
   ```
3. Check Slack for approval message
4. Approve and verify fix applied

## Debugging
- Set `LOG_LEVEL=debug` for verbose logging
- Check `/debug/approvals` endpoint for pending fixes
- Slack messages include full context and change details
