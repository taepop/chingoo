import { Injectable, NestMiddleware } from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import { TraceService } from './trace.service';

/**
 * Middleware to generate and attach trace_id to each request.
 * Uses AsyncLocalStorage to make trace_id available throughout the request lifecycle.
 */
@Injectable()
export class TraceMiddleware implements NestMiddleware {
  constructor(private readonly traceService: TraceService) {}

  use(req: FastifyRequest, res: FastifyReply, next: () => void) {
    // Extract trace_id from header if present (for testing/debugging), otherwise generate new
    const traceIdHeader = req.headers['x-trace-id'] as string | undefined;
    
    this.traceService.run(traceIdHeader, () => {
      const traceId = this.traceService.getTraceId();
      // Attach trace_id to response headers for debugging
      // Use raw Fastify reply to set headers
      if (traceId && res.raw) {
        res.raw.setHeader('X-Trace-Id', traceId);
      }
      next();
    });
  }
}
