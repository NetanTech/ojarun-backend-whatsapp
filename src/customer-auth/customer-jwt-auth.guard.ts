import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verifyToken } from '../auth/crypto.util';
import { AuthCustomer } from './current-customer.decorator';

@Injectable()
export class CustomerJwtAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header = request.headers.authorization as string | undefined;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Invalid or missing token');
    }

    const token = header.slice('Bearer '.length).trim();
    try {
      const payload = verifyToken(
        token,
        this.config.get<string>('jwt.secret') || 'dev-only-change-me',
      );
      if (payload.type !== 'access' || payload.kind !== 'customer') {
        throw new UnauthorizedException('Invalid or missing token');
      }

      const customer: AuthCustomer = {
        id: payload.sub,
        phone: payload.phone ?? '',
        name: payload.name ?? null,
      };

      request.user = customer;
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid or missing token');
    }
  }
}
