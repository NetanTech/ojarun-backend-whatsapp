import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CustomerJwtAuthGuard } from '../customer-auth/customer-jwt-auth.guard';
import {
  CurrentCustomer,
  AuthCustomer,
} from '../customer-auth/current-customer.decorator';
import { RewardsService } from './rewards.service';
import { ListRewardTransactionsQueryDto } from './dto/rewards.dto';

@Controller('customer-rewards')
@UseGuards(CustomerJwtAuthGuard)
export class CustomerRewardsController {
  constructor(private readonly rewards: RewardsService) {}

  @Get()
  getSummary(@CurrentCustomer() customer: AuthCustomer) {
    return this.rewards.getSummary(customer.id);
  }

  @Get('transactions')
  getTransactions(
    @CurrentCustomer() customer: AuthCustomer,
    @Query() query: ListRewardTransactionsQueryDto,
  ) {
    return this.rewards.getTransactions(customer.id, query.page, query.pageSize);
  }
}
