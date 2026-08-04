import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminRole } from '@prisma/client';
import { verifyToken } from './crypto.util';
import { AuthAdmin } from './current-admin.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
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
      if (payload.type !== 'access') {
        throw new UnauthorizedException('Invalid or missing token');
      }

      // Use claims from the token — avoids a Supabase round-trip on every request.
      const admin: AuthAdmin = {
        id: payload.sub,
        email: payload.email,
        name: payload.name ?? null,
        phone: payload.phone ?? null,
        role: (payload.role as AdminRole) || AdminRole.admin,
        avatarUrl: payload.avatarUrl ?? null,
        createdAt: new Date(0),
      };

      request.user = admin;
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid or missing token');
    }
  }
}
