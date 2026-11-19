import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

/**
 * Request tracing middleware that generates a unique request ID for each incoming request
 * and attaches it to the request context for use in logging and response headers.
 */
export function requestTracingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();

  const requestWithId = req as RequestWithRequestId;
  requestWithId.requestId = requestId;
  res.set('X-Request-ID', requestId);
  next();
}

/**
 * Extended Request type that includes request tracing properties
 */
export interface RequestWithRequestId extends Request {
  requestId: string;
}

/**
 * Helper function to get the request ID from a request object
 */
export function getRequestId(req: Request): string | undefined {
  return (req as RequestWithRequestId).requestId;
}

/**
 * Logger helper that automatically includes request ID in log messages
 */
export class RequestLogger {
  private req: Request;

  /**
   * Stores the request whose id is attached to every log line.
   *
   * @param req The request whose id and metadata are attached to every log line.
   */
  constructor(req: Request) {
    this.req = req;
  }

  /**
   * Renders one log line, prefixed with level and request id and suffixed with request metadata.
   *
   * @param level The log level label (e.g. 'WARN').
   * @param message The human-readable log message.
   * @param meta Optional structured extras merged into the trailing JSON object.
   * @returns The fully formatted log line.
   */
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

  /** Logs at debug level. */
  debug(message: string, meta?: object): void {
    console.debug(this.formatMessage('DEBUG', message, meta));
  }

  /** Logs at warn level. */
  warn(message: string, meta?: object): void {
    console.warn(this.formatMessage('WARN', message, meta));
  }

  /** Logs at error level, unwrapping an Error's message and stack into the metadata. */
  error(message: string | Error, meta?: object): void {
    const errorMessage = message instanceof Error ? message.message : message;
    const errorStack = message instanceof Error ? message.stack : undefined;
    console.error(
      this.formatMessage('ERROR', errorMessage, {
        ...meta,
        stack: errorStack
      })
    );
  }
}

/**
 * Create a logger instance for a specific request
 */
export function createRequestLogger(req: Request): RequestLogger {
  return new RequestLogger(req);
}
