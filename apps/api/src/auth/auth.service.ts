import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { AuthRequestDto, AuthResponseDto } from '@chingoo/shared';
import { UserState } from '@chingoo/shared';
import * as jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

@Injectable()
export class AuthService {
  private jwksClient: ReturnType<typeof jwksClient> | null = null;
  private readonly devBypassEnabled: boolean;

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {
    // [MINIMAL DEVIATION] Dev-only bypass for local development when JWKS config is missing
    // Default OFF - must explicitly enable via env var
    this.devBypassEnabled = process.env.AUTH_DEV_BYPASS === 'true';

    // Initialize JWKS client if not in dev bypass mode
    if (!this.devBypassEnabled) {
      const cognitoRegion = process.env.AWS_COGNITO_REGION || 'us-east-1';
      const cognitoUserPoolId = process.env.AWS_COGNITO_USER_POOL_ID;

      if (!cognitoUserPoolId) {
        throw new Error(
          'AWS_COGNITO_USER_POOL_ID is required when AUTH_DEV_BYPASS is not enabled',
        );
      }

      this.jwksClient = jwksClient({
        jwksUri: `https://cognito-idp.${cognitoRegion}.amazonaws.com/${cognitoUserPoolId}/.well-known/jwks.json`,
        cache: true,
        cacheMaxAge: 86400000, // 24 hours
      });
    }
  }

  /**
   * Validates Cognito ID token and returns user info
   * Per API_CONTRACT.md: POST /auth/login
   */
  async validateCognitoToken(identityToken: string): Promise<{
    sub: string;
    email?: string;
  }> {
    if (this.devBypassEnabled) {
      // [MINIMAL DEVIATION] Dev bypass: accept any token and extract sub from payload
      // This allows local development without Cognito setup
      try {
        const decoded = jwt.decode(identityToken, { complete: true });
        if (!decoded || typeof decoded === 'string') {
          throw new UnauthorizedException('Invalid token format');
        }

        const payload = decoded.payload as { sub?: string; email?: string };
        if (!payload.sub) {
          throw new UnauthorizedException('Token missing sub claim');
        }

        return {
          sub: payload.sub,
          email: payload.email,
        };
      } catch (error) {
        if (error instanceof UnauthorizedException) {
          throw error;
        }
        throw new UnauthorizedException('Failed to decode token');
      }
    }

    // Production: Validate token with Cognito JWKS
    return new Promise((resolve, reject) => {
      if (!this.jwksClient) {
        return reject(new Error('JWKS client not initialized'));
      }

      const getKey = (header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) => {
        if (!header.kid) {
          return callback(new Error('Token missing kid header'));
        }

        this.jwksClient!.getSigningKey(header.kid, (err, key) => {
          if (err) {
            return callback(err);
          }
          const signingKey = key.getPublicKey();
          callback(null, signingKey);
        });
      };

      jwt.verify(
        identityToken,
        getKey,
        {
          algorithms: ['RS256'],
        },
        (err, decoded) => {
          if (err) {
            return reject(new UnauthorizedException('Invalid token'));
          }

          const payload = decoded as jwt.JwtPayload;
          if (!payload.sub) {
            return reject(new UnauthorizedException('Token missing sub claim'));
          }

          resolve({
            sub: payload.sub,
            email: payload.email,
          });
        },
      );
    });
  }

  /**
   * Login or signup user
   * Per API_CONTRACT.md: POST /auth/login (or Signup)
   * Per SPEC_PATCH.md: /auth/signup is NOT a separate endpoint
   */
  async login(authRequest: AuthRequestDto): Promise<AuthResponseDto> {
    // Validate Cognito ID token
    const { sub: cognitoSub, email } = await this.validateCognitoToken(
      authRequest.identity_token,
    );

    // Find or create user
    let user = await this.prisma.user.findUnique({
      where: { cognitoSub },
    });

    if (!user) {
      // Create new user (signup flow)
      user = await this.prisma.user.create({
        data: {
          cognitoSub,
          state: UserState.CREATED,
        },
      });
    }

    // Generate access token (JWT)
    const accessToken = this.jwtService.sign(
      {
        sub: user.id,
        cognitoSub: user.cognitoSub,
      },
      {
        expiresIn: '7d', // Token expires in 7 days
      },
    );

    return {
      access_token: accessToken,
      user_id: user.id,
      state: user.state as UserState,
    };
  }
}
