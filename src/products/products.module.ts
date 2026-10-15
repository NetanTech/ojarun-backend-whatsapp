import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProductsController } from './products.controller';
import { StorefrontProductsController } from './storefront-products.controller';
import { ProductsService } from './products.service';
import { CatalogWarmupService } from './catalog-warmup.service';

@Module({
  imports: [AuthModule],
  controllers: [ProductsController, StorefrontProductsController],
  providers: [ProductsService, CatalogWarmupService],
  exports: [ProductsService],
})
export class ProductsModule {}
