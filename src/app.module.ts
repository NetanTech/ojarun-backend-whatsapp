import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import configuration from './config/configuration';
import { validateConfig } from './config/validation';

import { PrismaModule } from './prisma/prisma.module';
import { EmailModule } from './email/email.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { AuthModule } from './auth/auth.module';
import { ProductsModule } from './products/products.module';
import { OrdersModule } from './orders/orders.module';
import { UploadModule } from './upload/upload.module';
import { CustomersModule } from './customers/customers.module';
import { AdminsModule } from './admins/admins.module';
import { InboxModule } from './inbox/inbox.module';
import { PaystackModule } from './paystack/paystack.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateConfig,
    }),
    PrismaModule,
    EmailModule,
    WhatsappModule,
    PaystackModule,
    WebhooksModule,
    AuthModule,
    ProductsModule,
    OrdersModule,
    UploadModule,
    CustomersModule,
    AdminsModule,
    InboxModule,
  ],
})
export class AppModule {}
