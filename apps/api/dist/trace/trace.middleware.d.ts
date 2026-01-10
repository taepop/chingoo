import { NestMiddleware } from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import { TraceService } from './trace.service';
export declare class TraceMiddleware implements NestMiddleware {
    private readonly traceService;
    constructor(traceService: TraceService);
    use(req: FastifyRequest, res: FastifyReply, next: () => void): void;
}
