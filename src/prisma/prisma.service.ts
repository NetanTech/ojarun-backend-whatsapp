import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('Prisma connected');
    } catch (err) {
      this.logger.error(
        'Prisma failed to connect at startup — auth/DB routes will fail until DATABASE_URL is reachable',
        err as Error,
      );
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
