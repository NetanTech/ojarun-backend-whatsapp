import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { PromoCodesService } from './promo-codes.service';
import { ValidatePromoCodeDto } from './dto/promo-code.dto';
import { CustomerJwtAuthGuard } from '../customer-auth/customer-jwt-auth.guard';
import {
  CurrentCustomer,
  AuthCustomer,
} from '../customer-auth/current-customer.decorator';

@Controller('customer-promo-codes')
@UseGuards(CustomerJwtAuthGuard)
export class PromoCodesController {
  constructor(private readonly promoCodes: PromoCodesService) {}

  @Post('validate')
  @HttpCode(200)
  async validate(
    @CurrentCustomer() customer: AuthCustomer,
    @Body() dto: ValidatePromoCodeDto,
  ) {
    const { promoCode, discountAmount } = await this.promoCodes.validate(
      dto.code,
      customer.id,
      dto.subtotal,
    );
    return {
      code: promoCode.code,
      discountType: promoCode.discountType,
      discountValue: Number(promoCode.discountValue),
      discountAmount,
    };
  }
}
