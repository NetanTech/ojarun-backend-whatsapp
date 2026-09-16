import { Module } from '@nestjs/common';
import { AddressValidationService } from './address-validation.service';
import { DeliveryPricingService } from './delivery-pricing.service';
import { DeliveryController } from './delivery.controller';

/**
 * Location + delivery pricing. Deliberately depends on nothing in webhooks or
 * orders so both can import it without a circular reference.
 */
@Module({
  controllers: [DeliveryController],
  providers: [AddressValidationService, DeliveryPricingService],
  exports: [AddressValidationService, DeliveryPricingService],
})
export class DeliveryModule {}
