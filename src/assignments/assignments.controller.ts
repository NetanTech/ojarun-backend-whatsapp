import {
  Body,
  Controller,
  Get,
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
import { AssignmentsService } from './assignments.service';
import {
  ListMyAssignmentsQueryDto,
  ReleaseAssignmentDto,
} from './dto/assignment.dto';

@Controller('assignments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AdminRole.agent, AdminRole.admin, AdminRole.superadmin)
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  /** Unclaimed orders ready for shopping + delivery. */
  @Get('queue')
  listQueue() {
    return this.assignments.listQueue();
  }

  /** Orders this agent has claimed (or completed). */
  @Get('mine')
  listMine(
    @CurrentAdmin() admin: AuthAdmin,
    @Query() query: ListMyAssignmentsQueryDto,
  ) {
    return this.assignments.listMine(admin.id, query.status);
  }

  /** Who currently owns an order (if anyone). */
  @Get('order/:orderId')
  getActiveClaim(@Param('orderId') orderId: string) {
    return this.assignments.getActiveClaim(orderId);
  }

  /**
   * Exclusive claim — shopping + delivery for this order.
   * Second agent gets 409 Conflict.
   */
  @Post('order/:orderId/claim')
  claim(
    @Param('orderId') orderId: string,
    @CurrentAdmin() admin: AuthAdmin,
  ) {
    return this.assignments.claim(orderId, admin);
  }

  /** Release claim so another agent can pick it up. */
  @Post('order/:orderId/release')
  release(
    @Param('orderId') orderId: string,
    @CurrentAdmin() admin: AuthAdmin,
    @Body() dto: ReleaseAssignmentDto,
  ) {
    return this.assignments.release(orderId, admin, dto.reason);
  }
}
