import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

/**
 * Request tracing middleware that generates a unique request ID for each incoming request
 * and attaches it to the request context for use in logging and response headers.
 */
export function requestTracingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  
  // Attach request ID to the request object for use in controllers and services
  (req as RequestWithRequestId).requestId = requestId;
  
  // Attach request ID to res.locals for use in response handlers
  res.locals.requestId = requestId;
  
  // Add request ID to response headers for client correlation
  res.set('X-Request-ID', requestId);
  
  // Store start time for potential duration tracking
  (req as RequestWithRequestId).startTime = Date.now();
  
  next();
}

/**
 * Extended Request type that includes request tracing properties
 */
export interface RequestWithRequestId extends Request {
  requestId: string;
  startTime?: number;
}

/**
 * Helper function to get the request ID from a request object
 */
export function getRequestId(req: Request): string | undefined {
  return (req as RequestWithRequestId).requestId;
}

/**
 * Helper function to calculate request duration in milliseconds
 */
export function getRequestDuration(req: Request): number | undefined {
  const startTime = (req as RequestWithRequestId).startTime;
  if (startTime) {
    return Date.now() - startTime;
  }
  return undefined;
}

/**
 * Logger helper that automatically includes request ID in log messages
 */
export class RequestLogger {
  private req: Request;

  constructor(req: Request) {
    this.req = req;
  }

  private formatMessage(level: string, message: string, meta?: object): string {
    const requestId = getRequestId(this.req);
    const baseMeta = {
      requestId,
      method: this.req.method,
      path: this.req.path,
      ...meta
    };
    return `${level} [${requestId || 'no-id'}] ${message} ${JSON.stringify(baseMeta)}`;
  }

  debug(message: string, meta?: object): void {
    console.debug(this.formatMessage('DEBUG', message, meta));
  }

  log(message: string, meta?: object): void {
    console.log(this.formatMessage('INFO', message, meta));
  }

  warn(message: string, meta?: object): void {
    console.warn(this.formatMessage('WARN', message, meta));
  }

  error(message: string | Error, meta?: object): void {
    const errorMessage = message instanceof Error ? message.message : message;
    const errorStack = message instanceof Error ? message.stack : undefined;
    console.error(this.formatMessage('ERROR', errorMessage, {
      ...meta,
      stack: errorStack
    }));
  }
}

/**
 * Create a logger instance for a specific request
 */
export function createRequestLogger(req: Request): RequestLogger {
  return new RequestLogger(req);
}
