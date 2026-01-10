export declare class TraceService {
    private readonly asyncLocalStorage;
    run<T>(traceId: string | undefined, fn: () => T): T;
    getTraceId(): string | undefined;
    private generateTraceId;
}
