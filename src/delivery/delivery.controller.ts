import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeliveryPricingService } from './delivery-pricing.service';
import { DeliveryQuoteDto } from './dto/delivery-quote.dto';
import { CustomerJwtAuthGuard } from '../customer-auth/customer-jwt-auth.guard';

@Controller('delivery')
@UseGuards(CustomerJwtAuthGuard)
export class DeliveryController {
  constructor(
    private readonly pricing: DeliveryPricingService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Prices a delivery before checkout so the UI can show the fee the customer
   * is about to be charged. `createFromWeb` re-quotes server-side, so a stale
   * or tampered quote here can't change what's actually billed.
   */
  @Post('quote')
  @HttpCode(200)
  async quote(@Body() dto: DeliveryQuoteDto) {
    const quote = await this.pricing.quoteForAddress(dto.deliveryAddress);

    return {
      deliveryFee: quote.fee,
      serviceFee: this.config.get<number>('fees.serviceFeeNaira') ?? 1200,
      distanceKm: quote.distanceKm,
      formattedAddress: quote.formattedAddress,
      neighborhood: quote.neighborhood ?? null,
      estimated: quote.estimated,
      serviceable: quote.serviceable,
      origin: this.pricing.originName,
      message: quote.serviceable
        ? null
        : 'We only deliver within Ibadan for now. Please use an Ibadan address with a nearby landmark.',
    };
  }
}
