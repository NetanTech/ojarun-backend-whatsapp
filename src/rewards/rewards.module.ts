import { Module } from '@nestjs/common';
import { RewardsService } from './rewards.service';
import { CustomerRewardsController } from './customer-rewards.controller';

@Module({
  controllers: [CustomerRewardsController],
  providers: [RewardsService],
  exports: [RewardsService],
})
export class RewardsModule {}
