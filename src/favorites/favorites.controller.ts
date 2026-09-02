import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { FavoritesService } from './favorites.service';
import { CustomerJwtAuthGuard } from '../customer-auth/customer-jwt-auth.guard';
import {
  CurrentCustomer,
  AuthCustomer,
} from '../customer-auth/current-customer.decorator';

@Controller('customer-favorites')
@UseGuards(CustomerJwtAuthGuard)
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Get()
  findMine(@CurrentCustomer() customer: AuthCustomer) {
    return this.favorites.findMine(customer.id);
  }

  @Post(':productId')
  @HttpCode(200)
  add(
    @CurrentCustomer() customer: AuthCustomer,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.favorites.add(customer.id, productId);
  }

  @Delete(':productId')
  @HttpCode(200)
  remove(
    @CurrentCustomer() customer: AuthCustomer,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.favorites.remove(customer.id, productId);
  }
}
