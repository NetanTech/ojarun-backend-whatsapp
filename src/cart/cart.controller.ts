import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CartService } from './cart.service';
import { MergeCartDto, SetCartItemQuantityDto } from './dto/cart.dto';
import { CustomerJwtAuthGuard } from '../customer-auth/customer-jwt-auth.guard';
import {
  CurrentCustomer,
  AuthCustomer,
} from '../customer-auth/current-customer.decorator';

@Controller('customer-cart')
@UseGuards(CustomerJwtAuthGuard)
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  findMine(@CurrentCustomer() customer: AuthCustomer) {
    return this.cart.findMine(customer.id);
  }

  @Put(':productId')
  @HttpCode(200)
  setQuantity(
    @CurrentCustomer() customer: AuthCustomer,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: SetCartItemQuantityDto,
  ) {
    return this.cart.setQuantity(customer.id, productId, dto.quantity);
  }

  @Delete(':productId')
  @HttpCode(200)
  remove(
    @CurrentCustomer() customer: AuthCustomer,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.cart.remove(customer.id, productId);
  }

  @Delete()
  @HttpCode(200)
  clear(@CurrentCustomer() customer: AuthCustomer) {
    return this.cart.clear(customer.id);
  }

  @Post('merge')
  @HttpCode(200)
  merge(@CurrentCustomer() customer: AuthCustomer, @Body() dto: MergeCartDto) {
    return this.cart.merge(customer.id, dto.items);
  }
}
