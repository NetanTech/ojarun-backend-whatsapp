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
import { AddressesService } from './addresses.service';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';
import { CustomerJwtAuthGuard } from '../customer-auth/customer-jwt-auth.guard';
import {
  CurrentCustomer,
  AuthCustomer,
} from '../customer-auth/current-customer.decorator';

@Controller('customer-addresses')
@UseGuards(CustomerJwtAuthGuard)
export class AddressesController {
  constructor(private readonly addresses: AddressesService) {}

  @Get()
  findMine(@CurrentCustomer() customer: AuthCustomer) {
    return this.addresses.findMine(customer.id);
  }

  @Post()
  create(@CurrentCustomer() customer: AuthCustomer, @Body() dto: CreateAddressDto) {
    return this.addresses.create(customer.id, dto);
  }

  @Patch(':id')
  update(
    @CurrentCustomer() customer: AuthCustomer,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return this.addresses.update(customer.id, id, dto);
  }

  @Delete(':id')
  remove(
    @CurrentCustomer() customer: AuthCustomer,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.addresses.remove(customer.id, id);
  }
}
