import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  HttpStatus,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import {
  AuthRequestDto,
  AuthResponseDto,
  SignupRequestDto,
  UserState,
  ApiErrorDto,
} from '@chingoo/shared';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

/**
 * Password validation rules
 */
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*\d).+$/; // At least one letter and one number
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_SALT_ROUNDS = 12;

@Injectable()
export class AuthService {
  private jwksClient: ReturnType<typeof jwksClient> | null = null;
  private readonly devBypassEnabled: boolean;

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {
    // Dev-only bypass for local development when JWKS config is missing
    this.devBypassEnabled = process.env.DEV_BYPASS_AUTH === 'true';

    // Initialize JWKS client if not in dev bypass mode (for Cognito support)
    if (!this.devBypassEnabled && process.env.AWS_COGNITO_USER_POOL_ID) {
      const cognitoRegion = process.env.AWS_COGNITO_REGION || 'us-east-1';
      const cognitoUserPoolId = process.env.AWS_COGNITO_USER_POOL_ID;

      this.jwksClient = jwksClient({
        jwksUri: `https://cognito-idp.${cognitoRegion}.amazonaws.com/${cognitoUserPoolId}/.well-known/jwks.json`,
        cache: true,
        cacheMaxAge: 86400000, // 24 hours
      });
    }
  }

  /**
   * Sign up a new user with email and password.
   * 
   * @param signupRequest - Signup request with email, password, confirm_password
   * @returns AuthResponseDto with access token and user info
   */
  async signup(signupRequest: SignupRequestDto): Promise<AuthResponseDto> {
    const { email, password, confirm_password } = signupRequest;

    // Validate email format
    if (!email || !EMAIL_REGEX.test(email)) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Invalid email format',
        error: 'Bad Request',
        constraints: ['email must be a valid email address'],
      } as ApiErrorDto);
    }

    // Validate password
    const passwordErrors = this.validatePassword(password);
    if (passwordErrors.length > 0) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Password does not meet requirements',
        error: 'Bad Request',
        constraints: passwordErrors,
      } as ApiErrorDto);
    }

    // Check password confirmation
    if (password !== confirm_password) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Passwords do not match',
        error: 'Bad Request',
        constraints: ['password and confirm_password must match'],
      } as ApiErrorDto);
    }

    // Check if email already exists
    const existingUser = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (existingUser) {
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        message: 'An account with this email already exists',
        error: 'Conflict',
      } as ApiErrorDto);
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

    // Create user
    const user = await this.prisma.user.create({
      data: {
        email: email.toLowerCase(),
        passwordHash,
        emailVerified: false, // Email verification can be added later
        state: UserState.CREATED,
      },
    });

    // Generate access token
    const accessToken = this.generateAccessToken(user.id, user.email!);

    return {
      access_token: accessToken,
      user_id: user.id,
      email: user.email!,
      state: user.state as UserState,
    };
  }

  /**
   * Login user with email/password or Cognito token.
   * 
   * @param authRequest - Login request (email+password OR identity_token)
   * @returns AuthResponseDto with access token and user info
   */
  async login(authRequest: AuthRequestDto): Promise<AuthResponseDto> {
    // Determine auth method
    if (authRequest.email && authRequest.password) {
      return this.loginWithEmailPassword(authRequest.email, authRequest.password);
    }

    if (authRequest.identity_token) {
      return this.loginWithCognitoToken(authRequest.identity_token);
    }

    throw new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      message: 'Either email+password or identity_token is required',
      error: 'Bad Request',
      constraints: [
        'Provide email and password for email/password auth',
        'Or provide identity_token for Cognito auth',
      ],
    } as ApiErrorDto);
  }

  /**
   * Login with email and password.
   */
  private async loginWithEmailPassword(
    email: string,
    password: string,
  ): Promise<AuthResponseDto> {
    // Find user by email
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException({
        statusCode: HttpStatus.UNAUTHORIZED,
        message: 'Invalid email or password',
        error: 'Unauthorized',
      } as ApiErrorDto);
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      throw new UnauthorizedException({
        statusCode: HttpStatus.UNAUTHORIZED,
        message: 'Invalid email or password',
        error: 'Unauthorized',
      } as ApiErrorDto);
    }

    // Generate access token
    const accessToken = this.generateAccessToken(user.id, user.email!);

    return {
      access_token: accessToken,
      user_id: user.id,
      email: user.email!,
      state: user.state as UserState,
    };
  }

  /**
   * Login with Cognito identity token (legacy/alternative method).
   */
  private async loginWithCognitoToken(identityToken: string): Promise<AuthResponseDto> {
    // Validate Cognito ID token
    const { sub: cognitoSub, email } = await this.validateCognitoToken(identityToken);

    // Find or create user
    let user = await this.prisma.user.findUnique({
      where: { cognitoSub },
    });

    if (!user) {
      // Create new user (signup via Cognito)
      user = await this.prisma.user.create({
        data: {
          cognitoSub,
          email: email?.toLowerCase(),
          emailVerified: true, // Cognito handles email verification
          state: UserState.CREATED,
        },
      });
    }

    // Generate access token
    const accessToken = this.generateAccessToken(user.id, user.email || undefined);

    return {
      access_token: accessToken,
      user_id: user.id,
      email: user.email || undefined,
      state: user.state as UserState,
    };
  }

  /**
   * Validates Cognito ID token and returns user info.
   */
  private async validateCognitoToken(identityToken: string): Promise<{
    sub: string;
    email?: string;
  }> {
    if (this.devBypassEnabled) {
      // Dev bypass: use DEV_USER_SUB for deterministic user identity
      const devUserSub = process.env.DEV_USER_SUB || 'dev-sub-0001';

      // Optionally decode token to extract email if present
      let email: string | undefined;
      try {
        const decoded = jwt.decode(identityToken, { complete: true });
        if (decoded && typeof decoded !== 'string' && decoded.payload) {
          const payload = decoded.payload as { email?: string };
          email = payload.email;
        }
      } catch {
        // Ignore decode errors in dev bypass
      }

      return { sub: devUserSub, email };
    }

    // Production: Validate token with Cognito JWKS
    if (!this.jwksClient) {
      throw new UnauthorizedException({
        statusCode: HttpStatus.UNAUTHORIZED,
        message: 'Cognito authentication not configured',
        error: 'Unauthorized',
      } as ApiErrorDto);
    }

    return new Promise((resolve, reject) => {
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
        { algorithms: ['RS256'] },
        (err, decoded) => {
          if (err) {
            return reject(
              new UnauthorizedException({
                statusCode: HttpStatus.UNAUTHORIZED,
                message: 'Invalid token',
                error: 'Unauthorized',
              } as ApiErrorDto),
            );
          }

          const payload = decoded as jwt.JwtPayload;
          if (!payload.sub) {
            return reject(
              new UnauthorizedException({
                statusCode: HttpStatus.UNAUTHORIZED,
                message: 'Token missing sub claim',
                error: 'Unauthorized',
              } as ApiErrorDto),
            );
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
   * Generate JWT access token.
   */
  private generateAccessToken(userId: string, email?: string): string {
    return this.jwtService.sign(
      {
        sub: userId,
        email,
      },
      {
        expiresIn: '7d',
      },
    );
  }

  /**
   * Validate password against requirements.
   * Returns array of error messages (empty if valid).
   */
  private validatePassword(password: string): string[] {
    const errors: string[] = [];

    if (!password) {
      errors.push('Password is required');
      return errors;
    }

    if (password.length < PASSWORD_MIN_LENGTH) {
      errors.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
    }

    if (!PASSWORD_REGEX.test(password)) {
      errors.push('Password must contain at least one letter and one number');
    }

    return errors;
  }
}
