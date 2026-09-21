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
   * Prices a delivery from a map pin before checkout. createFromWeb re-quotes
   * server-side from the same lat/lng, so a tampered client fee can't change
   * what's billed.
   */
  @Post('quote')
  @HttpCode(200)
  async quote(@Body() dto: DeliveryQuoteDto) {
    const quote = await this.pricing.quoteForCoords(
      dto.lat,
      dto.lng,
      dto.deliveryAddress ?? '',
    );

    return {
      deliveryFee: quote.fee,
      serviceFee: this.config.get<number>('fees.serviceFeeNaira') ?? 1200,
      distanceKm: quote.distanceKm,
      lat: quote.lat,
      lng: quote.lng,
      formattedAddress: quote.formattedAddress || dto.deliveryAddress || null,
      neighborhood: quote.neighborhood ?? null,
      estimated: quote.estimated,
      serviceable: quote.serviceable,
      origin: this.pricing.originName,
      message: quote.serviceable
        ? null
        : 'We only deliver within Ibadan for now. Move the pin closer to your drop-off point inside Ibadan.',
    };
  }
}
