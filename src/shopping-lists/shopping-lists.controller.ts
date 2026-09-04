import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ShoppingListsService } from './shopping-lists.service';
import { CreateShoppingListDto, UpdateShoppingListDto } from './dto/shopping-list.dto';
import { CustomerJwtAuthGuard } from '../customer-auth/customer-jwt-auth.guard';
import {
  CurrentCustomer,
  AuthCustomer,
} from '../customer-auth/current-customer.decorator';

@Controller('customer-shopping-lists')
@UseGuards(CustomerJwtAuthGuard)
export class ShoppingListsController {
  constructor(private readonly lists: ShoppingListsService) {}

  @Get()
  findMine(@CurrentCustomer() customer: AuthCustomer) {
    return this.lists.findMine(customer.id);
  }

  @Post()
  create(@CurrentCustomer() customer: AuthCustomer, @Body() dto: CreateShoppingListDto) {
    return this.lists.create(customer.id, dto);
  }

  @Patch(':id')
  update(
    @CurrentCustomer() customer: AuthCustomer,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateShoppingListDto,
  ) {
    return this.lists.update(customer.id, id, dto);
  }

  @Delete(':id')
  remove(
    @CurrentCustomer() customer: AuthCustomer,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.lists.remove(customer.id, id);
  }
}
