import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export type AuthCustomer = {
  id: string;
  phone: string;
  name: string | null;
};

export const CurrentCustomer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthCustomer => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
