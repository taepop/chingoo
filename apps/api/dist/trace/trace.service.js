"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TraceService = void 0;
const common_1 = require("@nestjs/common");
const async_hooks_1 = require("async_hooks");
let TraceService = class TraceService {
    constructor() {
        this.asyncLocalStorage = new async_hooks_1.AsyncLocalStorage();
    }
    run(traceId, fn) {
        const id = traceId || this.generateTraceId();
        return this.asyncLocalStorage.run(id, fn);
    }
    getTraceId() {
        return this.asyncLocalStorage.getStore();
    }
    generateTraceId() {
        return crypto.randomUUID();
    }
};
exports.TraceService = TraceService;
exports.TraceService = TraceService = __decorate([
    (0, common_1.Injectable)()
], TraceService);
//# sourceMappingURL=trace.service.js.map