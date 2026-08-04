import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminRole } from '@prisma/client';
import { ROLES_KEY } from './roles.decorator';
import { AuthAdmin } from './current-admin.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<AdminRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles?.length) return true;

    const request = context.switchToHttp().getRequest();
    const admin = request.user as AuthAdmin | undefined;
    if (!admin) {
      throw new ForbiddenException('Access denied');
    }
    if (admin.role === AdminRole.superadmin) return true;
    if (!roles.includes(admin.role)) {
      throw new ForbiddenException('You do not have permission for this action');
    }
    return true;
  }
}
