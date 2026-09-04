import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProductsController } from './products.controller';
import { StorefrontProductsController } from './storefront-products.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [AuthModule],
  controllers: [ProductsController, StorefrontProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
