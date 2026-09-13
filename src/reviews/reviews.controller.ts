import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/review.dto';
import { CustomerJwtAuthGuard } from '../customer-auth/customer-jwt-auth.guard';
import {
  CurrentCustomer,
  AuthCustomer,
} from '../customer-auth/current-customer.decorator';

@Controller('customer-reviews')
@UseGuards(CustomerJwtAuthGuard)
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  findMine(@CurrentCustomer() customer: AuthCustomer) {
    return this.reviews.findMine(customer.id);
  }

  @Get('order/:orderId')
  findForOrder(
    @CurrentCustomer() customer: AuthCustomer,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.reviews.findForOrder(customer.id, orderId);
  }

  @Post('order/:orderId')
  @HttpCode(201)
  create(
    @CurrentCustomer() customer: AuthCustomer,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CreateReviewDto,
  ) {
    return this.reviews.create(customer.id, orderId, dto);
  }
}
