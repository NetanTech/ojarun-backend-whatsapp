import { Controller, Get, Param, Query } from '@nestjs/common';
import { ProductsService } from './products.service';

// Deliberately unauthenticated and on a separate path from the admin
// ProductsController (/products, guarded) — browsing the catalog shouldn't
// require an account, same as the cart already working without login.
@Controller('storefront-products')
export class StorefrontProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  findAll(@Query('search') search?: string, @Query('category') category?: string) {
    return this.products.findAllPublic(search, category);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.products.findOnePublic(id);
  }
}
