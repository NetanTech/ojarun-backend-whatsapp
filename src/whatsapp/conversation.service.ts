import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ConversationService {
  constructor(private prisma: PrismaService) {}

  async getOrCreate(customerId: string) {
    let convo = await this.prisma.conversation.findUnique({
      where: { customerId },
    });

    if (!convo) {
      convo = await this.prisma.conversation.create({
        data: {
          customerId,
          mode: 'bot',
          state: { step: 'idle' },
        },
      });
    }

    return convo;
  }

  async setState(conversationId: string, state: object) {
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: { state },
    });
  }

  async setHumanMode(conversationId: string) {
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: { mode: 'human' },
    });
  }
}