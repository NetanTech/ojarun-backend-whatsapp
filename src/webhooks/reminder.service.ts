import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';

@Injectable()
export class ReminderService {
  private readonly logger = new Logger(ReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async remindPendingOrders(): Promise<void> {
    const cutoff = new Date(Date.now() - 15 * 60 * 1000); // 15 mins ago

    const stale = await this.prisma.pendingOrder.findMany({
      where: {
        completed: false,
        remindedAt: null,
        startedAt: { lt: cutoff },
      },
    });

    this.logger.log(`Reminder check: ${stale.length} stale order(s) found`);

    for (const order of stale) {
      await this.whatsapp.sendText(
        order.phone,
        `Hey! 👋 Looks like you didn't finish your OjaRun order.\n\n` +
        `Just send us your items + delivery address and we'll sort it out quickly! 🛒\n\n` +
        `Reply *ORDER* to continue or *MENU* to browse.`,
      );

      await this.prisma.pendingOrder.update({
        where: { id: order.id },
        data: { remindedAt: new Date() },
      });

      this.logger.log(`Reminder sent to ${order.phone}`);
    }
  }
}