import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';

export interface JwtPayload {
  sub: string; // user_id
  cognitoSub: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private prisma: PrismaService) {
    // [MINIMAL DEVIATION] Dev bypass: use a simple secret for local development
    const devBypass = process.env.DEV_BYPASS_AUTH === 'true';
    const secret = devBypass
      ? process.env.JWT_SECRET || 'dev-secret-change-in-production'
      : process.env.JWT_SECRET;

    if (!secret) {
      throw new Error(
        'JWT_SECRET not configured. Set JWT_SECRET env var or enable DEV_BYPASS_AUTH=true',
      );
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  async validate(payload: JwtPayload) {
    // Verify user exists
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return {
      userId: user.id,
      cognitoSub: user.cognitoSub,
      state: user.state,
    };
  }
}
