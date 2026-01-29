import { Request, Response, NextFunction } from 'express';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    logger.warn('Missing Authorization header', { path: req.path });
    res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Missing Authorization header',
    });
    return;
  }

  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    logger.warn('Invalid Authorization format', { path: req.path });
    res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Invalid Authorization format. Use: Bearer <token>',
    });
    return;
  }

  if (token !== config.apiBearerToken) {
    logger.warn('Invalid Bearer token', { path: req.path });
    res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'Invalid Bearer token',
    });
    return;
  }

  next();
}
