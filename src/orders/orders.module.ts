import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PaystackModule } from '../paystack/paystack.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { OrdersController } from './orders.controller';
import { CustomerOrdersController } from './customer-orders.controller';
import { CustomerOrderHistoryController } from './customer-order-history.controller';
import { OrdersService } from './orders.service';
import { AdminNotificationService } from '../admins/admin-notification.service';
import { PromoCodesModule } from '../promo-codes/promo-codes.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    AuthModule,
    PaystackModule,
    WhatsappModule,
    PromoCodesModule,
    NotificationsModule,
  ],
  controllers: [
    OrdersController,
    CustomerOrdersController,
    CustomerOrderHistoryController,
  ],
  providers: [OrdersService, AdminNotificationService],
  exports: [OrdersService],
})
export class OrdersModule {}
