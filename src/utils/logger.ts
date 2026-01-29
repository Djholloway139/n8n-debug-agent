import winston from 'winston';
import { config } from './config.js';

const { combine, timestamp, json, errors, printf } = winston.format;

// Custom format for development
const devFormat = printf(({ level, message, timestamp, requestId, ...meta }) => {
  const reqIdStr = requestId ? `[${requestId}] ` : '';
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} ${level.toUpperCase()} ${reqIdStr}${message}${metaStr}`;
});

// Create logger instance
export const logger = winston.createLogger({
  level: config.logLevel,
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    config.nodeEnv === 'production' ? json() : devFormat
  ),
  defaultMeta: { service: 'n8n-debug-agent' },
  transports: [
    new winston.transports.Console(),
  ],
});

// Create a child logger with request ID
export function createRequestLogger(requestId: string): winston.Logger {
  return logger.child({ requestId });
}

// Express middleware to add request logging
export function requestLoggerMiddleware(
  req: { requestId?: string; log?: winston.Logger },
  _res: unknown,
  next: () => void
): void {
  const requestId = req.requestId || 'unknown';
  req.log = createRequestLogger(requestId);
  next();
}
