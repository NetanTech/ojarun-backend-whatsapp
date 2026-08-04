import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentAdmin, AuthAdmin } from '../auth/current-admin.decorator';
import { InboxService } from './inbox.service';
import { ReplyConversationDto } from './dto/inbox.dto';

@Controller('messages')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(
  AdminRole.superadmin,
  AdminRole.admin,
  AdminRole.customer_care,
  AdminRole.customer_support,
)
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  list(@Query('search') search?: string) {
    return this.inbox.list(search);
  }

  @Get(':customerId')
  getThread(
    @Param('customerId') customerId: string,
    @Query('limit') limit?: string,
  ) {
    const take = limit ? Number(limit) : 80;
    return this.inbox.getMessages(customerId, Number.isFinite(take) ? take : 80);
  }

  @Post(':customerId/takeover')
  @HttpCode(200)
  takeover(
    @Param('customerId') customerId: string,
    @CurrentAdmin() admin: AuthAdmin,
  ) {
    return this.inbox.takeover(customerId, admin.id);
  }

  @Post(':customerId/release')
  @HttpCode(200)
  release(@Param('customerId') customerId: string) {
    return this.inbox.release(customerId);
  }

  @Post(':customerId/reply')
  @HttpCode(200)
  reply(
    @Param('customerId') customerId: string,
    @CurrentAdmin() admin: AuthAdmin,
    @Body() dto: ReplyConversationDto,
  ) {
    return this.inbox.reply(customerId, admin.id, dto.body);
  }
}
