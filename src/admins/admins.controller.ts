import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentAdmin, AuthAdmin } from '../auth/current-admin.decorator';
import { UpdateAdminRoleDto } from '../auth/dto/auth.dto';
import { AdminsService } from './admins.service';

@Controller('admins')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminsController {
  constructor(private readonly admins: AdminsService) {}

  @Get()
  findAll(@Query('search') search?: string) {
    return this.admins.findAll(search);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.admins.findOne(id);
  }

  @Patch(':id/role')
  @Roles(AdminRole.superadmin)
  updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateAdminRoleDto,
    @CurrentAdmin() admin: AuthAdmin,
  ) {
    return this.admins.updateRole(id, dto.role, admin.id);
  }
}
