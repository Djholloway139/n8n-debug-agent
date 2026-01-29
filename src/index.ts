import express, { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { config } from './utils/config.js';
import { logger, requestLoggerMiddleware } from './utils/logger.js';
import { debugRouter } from './routes/debug.js';
import { slackRouter } from './routes/slack.js';
import { approvalStore } from './services/approvalStore.js';
import { bearerAuth } from './middleware/auth.js';

const app = express();

// Store raw body for Slack signature verification
app.use(express.json({
  verify: (req: Request & { rawBody?: string }, _res, buf) => {
    req.rawBody = buf.toString();
  },
}));

app.use(express.urlencoded({ extended: true }));

// Add request ID to all requests
app.use((req: Request & { requestId?: string }, _res: Response, next: NextFunction) => {
  req.requestId = req.headers['x-request-id'] as string || uuidv4();
  next();
});

// Request logging middleware
app.use(requestLoggerMiddleware as express.RequestHandler);

// Request logging
app.use((req: Request & { requestId?: string }, res: Response, next: NextFunction) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('Request completed', {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
    });
  });

  next();
});

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
  });
});

// Mount routers
app.use('/debug', bearerAuth, debugRouter);
app.use('/slack', slackRouter); // Slack has its own signature verification

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    message: 'The requested endpoint does not exist',
  });
});

// Error handler
app.use((err: Error, req: Request & { requestId?: string }, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error', {
    requestId: req.requestId,
    error: err.message,
    stack: err.stack,
  });

  res.status(500).json({
    success: false,
    error: 'Internal Server Error',
    message: config.nodeEnv === 'development' ? err.message : 'An unexpected error occurred',
  });
});

// Start server
const server = app.listen(config.port, () => {
  logger.info('n8n Debug Agent started', {
    port: config.port,
    environment: config.nodeEnv,
  });
});

// Graceful shutdown
function shutdown(signal: string): void {
  logger.info(`${signal} received, shutting down gracefully`);

  server.close(() => {
    logger.info('HTTP server closed');

    // Cleanup
    approvalStore.destroy();

    logger.info('Cleanup complete, exiting');
    process.exit(0);
  });

  // Force exit after timeout
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app };
