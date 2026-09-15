import { Module } from '@nestjs/common';
import { MealFavoritesController } from './meal-favorites.controller';
import { MealFavoritesService } from './meal-favorites.service';

@Module({
  controllers: [MealFavoritesController],
  providers: [MealFavoritesService],
})
export class MealFavoritesModule {}
