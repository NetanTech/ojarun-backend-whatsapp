import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import configuration from './config/configuration';
import { validateConfig } from './config/validation';

import { PrismaModule } from './prisma/prisma.module';
import { EmailModule } from './email/email.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { AuthModule } from './auth/auth.module';
import { CustomerAuthModule } from './customer-auth/customer-auth.module';
import { SmsModule } from './sms/sms.module';
import { ProductsModule } from './products/products.module';
import { OrdersModule } from './orders/orders.module';
import { UploadModule } from './upload/upload.module';
import { CustomersModule } from './customers/customers.module';
import { AdminsModule } from './admins/admins.module';
import { InboxModule } from './inbox/inbox.module';
import { PaystackModule } from './paystack/paystack.module';
import { FavoritesModule } from './favorites/favorites.module';
import { ShoppingListsModule } from './shopping-lists/shopping-lists.module';
import { PromoCodesModule } from './promo-codes/promo-codes.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateConfig,
    }),
    PrismaModule,
    EmailModule,
    SmsModule,
    WhatsappModule,
    PaystackModule,
    WebhooksModule,
    AuthModule,
    CustomerAuthModule,
    ProductsModule,
    OrdersModule,
    UploadModule,
    CustomersModule,
    AdminsModule,
    InboxModule,
    FavoritesModule,
    ShoppingListsModule,
    PromoCodesModule,
  ],
})
export class AppModule {}
