import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/order.dto';
import { CustomerJwtAuthGuard } from '../customer-auth/customer-jwt-auth.guard';
import {
  CurrentCustomer,
  AuthCustomer,
} from '../customer-auth/current-customer.decorator';

@Controller('orders')
@UseGuards(CustomerJwtAuthGuard)
export class CustomerOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @HttpCode(201)
  create(@CurrentCustomer() customer: AuthCustomer, @Body() dto: CreateOrderDto) {
    return this.orders.createFromWeb(customer.id, dto);
  }
}
