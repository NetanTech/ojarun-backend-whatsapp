import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentAdmin, AuthAdmin } from '../auth/current-admin.decorator';
import {
  InviteAdminDto,
  UpdateAdminDto,
  UpdateAdminRoleDto,
} from '../auth/dto/auth.dto';
import { AdminsService } from './admins.service';

@Controller('admins')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminsController {
  constructor(private readonly admins: AdminsService) {}

  @Get()
  findAll(@Query('search') search?: string) {
    return this.admins.findAll(search);
  }

  @Post('invite')
  @Roles(AdminRole.superadmin, AdminRole.admin)
  invite(@Body() dto: InviteAdminDto, @CurrentAdmin() admin: AuthAdmin) {
    return this.admins.invite(dto, admin.id, admin.role);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.admins.findOne(id);
  }

  @Patch(':id')
  @Roles(AdminRole.superadmin, AdminRole.admin)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAdminDto,
    @CurrentAdmin() admin: AuthAdmin,
  ) {
    return this.admins.update(id, dto, admin.id);
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

  @Delete(':id')
  @Roles(AdminRole.superadmin)
  remove(@Param('id') id: string, @CurrentAdmin() admin: AuthAdmin) {
    return this.admins.remove(id, admin.id);
  }
}
