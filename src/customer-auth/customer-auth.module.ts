import { Module } from '@nestjs/common';
import { CustomerAuthController } from './customer-auth.controller';
import { CustomerAuthService } from './customer-auth.service';
import { RewardsModule } from '../rewards/rewards.module';

@Module({
  imports: [RewardsModule],
  controllers: [CustomerAuthController],
  providers: [CustomerAuthService],
})
export class CustomerAuthModule {}
