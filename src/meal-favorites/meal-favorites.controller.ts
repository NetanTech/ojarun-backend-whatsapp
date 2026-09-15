import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MealFavoritesService } from './meal-favorites.service';
import { AddMealFavoriteDto } from './dto/meal-favorite.dto';
import { CustomerJwtAuthGuard } from '../customer-auth/customer-jwt-auth.guard';
import {
  CurrentCustomer,
  AuthCustomer,
} from '../customer-auth/current-customer.decorator';

@Controller('customer-meal-favorites')
@UseGuards(CustomerJwtAuthGuard)
export class MealFavoritesController {
  constructor(private readonly mealFavorites: MealFavoritesService) {}

  @Get()
  findMine(@CurrentCustomer() customer: AuthCustomer) {
    return this.mealFavorites.findMine(customer.id);
  }

  @Post(':mealId')
  @HttpCode(200)
  add(
    @CurrentCustomer() customer: AuthCustomer,
    @Param('mealId') mealId: string,
    @Body() dto: AddMealFavoriteDto,
  ) {
    return this.mealFavorites.add(customer.id, mealId, dto);
  }

  @Delete(':mealId')
  @HttpCode(200)
  remove(
    @CurrentCustomer() customer: AuthCustomer,
    @Param('mealId') mealId: string,
  ) {
    return this.mealFavorites.remove(customer.id, mealId);
  }
}
