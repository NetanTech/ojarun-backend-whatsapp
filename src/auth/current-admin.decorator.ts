import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AdminRole } from '@prisma/client';

export type AuthAdmin = {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  role: AdminRole;
  avatarUrl: string | null;
  createdAt: Date;
};

export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthAdmin => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
