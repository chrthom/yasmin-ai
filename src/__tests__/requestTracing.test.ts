import { NextFunction, Request, Response } from 'express';
import { createRequestLogger, getRequestId, requestTracingMiddleware } from '../middleware/requestTracing';

describe('request tracing', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the no-id fallback for a request that bypassed tracing middleware', () => {
    const req = { method: 'GET', path: '/test' } as Request;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    createRequestLogger(req).warn('untraced');

    expect(getRequestId(req)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('WARN [no-id] untraced {"method":"GET","path":"/test"}');
  });

  it('merges extra metadata and lets it override base fields without changing the request ID prefix', () => {
    const req = { method: 'POST', path: '/chat/bot' } as Request;
    requestTracingMiddleware(req, { set: jest.fn() } as unknown as Response, jest.fn());
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => undefined);
    const logger = createRequestLogger(req);
    const prefix = `DEBUG [${getRequestId(req)}] started `;

    logger.debug('started', { username: 'Alice' });
    expect(debug).toHaveBeenLastCalledWith(
      prefix +
        JSON.stringify({ requestId: getRequestId(req), method: 'POST', path: '/chat/bot', username: 'Alice' })
    );

    logger.debug('started', { requestId: 'external-id', method: 'PATCH', path: '/override' });
    expect(debug).toHaveBeenLastCalledWith(
      prefix + JSON.stringify({ requestId: 'external-id', method: 'PATCH', path: '/override' })
    );
    expect(getRequestId(req)).not.toBe('external-id');
  });

  it('sets a unique request ID on the request and response header', () => {
    const req = { method: 'POST', path: '/chat/bot' } as Request;
    const res = { set: jest.fn() } as unknown as Response;
    const next = jest.fn() as NextFunction;

    requestTracingMiddleware(req, res, next);
    const id = getRequestId(req);

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(res.set).toHaveBeenCalledWith('X-Request-ID', id);
    expect(next).toHaveBeenCalledTimes(1);

    const anotherRequest = {} as Request;
    requestTracingMiddleware(anotherRequest, res, next);
    expect(getRequestId(anotherRequest)).not.toBe(id);
  });

  it('includes request metadata in debug, warning and error logs', () => {
    const req = { method: 'POST', path: '/chat/bot' } as Request;
    requestTracingMiddleware(req, { set: jest.fn() } as unknown as Response, jest.fn());
    const logger = createRequestLogger(req);
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      logger.debug('started', { username: 'Alice' });
      logger.warn('invalid');
      logger.error(new Error('failed'));
      const id = getRequestId(req);
      expect(debug).toHaveBeenCalledWith(expect.stringContaining(`DEBUG [${id}] started`));
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('"username":"Alice"'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`WARN [${id}] invalid`));
      expect(error).toHaveBeenCalledWith(expect.stringContaining(`ERROR [${id}] failed`));
      expect(error).toHaveBeenCalledWith(expect.stringContaining('"stack":'));
    } finally {
      debug.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
