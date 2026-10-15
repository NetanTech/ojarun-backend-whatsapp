import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness — cheap, no DB. Used by keep-alive pings / Render health checks. */
  @Get('health')
  health() {
    return {
      ok: true,
      service: 'ojarun-backend',
      ts: new Date().toISOString(),
    };
  }

  /** Readiness — confirms Postgres is reachable after a cold start. */
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        ok: true,
        db: true,
        ts: new Date().toISOString(),
      };
    } catch {
      throw new ServiceUnavailableException({
        ok: false,
        db: false,
        message: 'Database not ready',
      });
    }
  }
}
