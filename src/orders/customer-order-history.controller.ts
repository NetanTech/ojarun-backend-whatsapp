import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CancelOrderDto } from './dto/order.dto';
import { CustomerJwtAuthGuard } from '../customer-auth/customer-jwt-auth.guard';
import {
  CurrentCustomer,
  AuthCustomer,
} from '../customer-auth/current-customer.decorator';

// Deliberately a separate path (not /orders) so there's no risk of this
// colliding with the admin OrdersController's GET /orders and GET /orders/:id
// routes, which are guarded by a completely different auth (admin JWT).
@Controller('customer-orders')
@UseGuards(CustomerJwtAuthGuard)
export class CustomerOrderHistoryController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  findMine(@CurrentCustomer() customer: AuthCustomer) {
    return this.orders.findMineList(customer.id);
  }

  @Get(':id')
  findOne(@CurrentCustomer() customer: AuthCustomer, @Param('id') id: string) {
    return this.orders.findMineOne(customer.id, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentCustomer() customer: AuthCustomer,
    @Param('id') id: string,
    @Body() dto: CancelOrderDto,
  ) {
    return this.orders.cancelMine(customer.id, id, dto.reason);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  confirm(@CurrentCustomer() customer: AuthCustomer, @Param('id') id: string) {
    return this.orders.confirmMine(customer.id, id);
  }
}
