import { Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { CustomerJwtAuthGuard } from '../customer-auth/customer-jwt-auth.guard';
import {
  CurrentCustomer,
  AuthCustomer,
} from '../customer-auth/current-customer.decorator';

@Controller('customer-notifications')
@UseGuards(CustomerJwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  findMine(@CurrentCustomer() customer: AuthCustomer) {
    return this.notifications.findMine(customer.id);
  }

  @Post(':id/read')
  @HttpCode(200)
  markRead(@CurrentCustomer() customer: AuthCustomer, @Param('id') id: string) {
    return this.notifications.markRead(customer.id, id);
  }

  @Post('read-all')
  @HttpCode(200)
  markAllRead(@CurrentCustomer() customer: AuthCustomer) {
    return this.notifications.markAllRead(customer.id);
  }
}
