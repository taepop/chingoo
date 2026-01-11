import { Injectable, ExecutionContext, UnauthorizedException, HttpStatus } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { ApiErrorDto } from '@chingoo/shared';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    return super.canActivate(context);
  }

  handleRequest(err: any, user: any, info: any, context: ExecutionContext) {
    // If authentication fails, throw UnauthorizedException with ApiErrorDto format
    if (err || !user) {
      const errorResponse: ApiErrorDto = {
        statusCode: HttpStatus.UNAUTHORIZED,
        message: 'Invalid or missing Auth Token',
        error: 'Unauthorized',
      };
      throw new UnauthorizedException(errorResponse);
    }
    return user;
  }
}
