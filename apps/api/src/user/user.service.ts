import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserProfileResponseDto, UserState } from '@chingoo/shared';

@Injectable()
export class UserService {
  constructor(private prisma: PrismaService) {}

  /**
   * Get user profile
   * Per API_CONTRACT.md: GET /user/me
   */
  async getProfile(userId: string): Promise<UserProfileResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        onboardingAnswers: true,
        conversations: {
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      user_id: user.id,
      preferred_name: user.onboardingAnswers?.preferredName || '',
      state: user.state as UserState,
      conversation_id: user.conversations[0]?.id,
    };
  }
}
