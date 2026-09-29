import { CanActivate, ExecutionContext, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { SESSION_COOKIE } from '../auth/session.guard';

// Same session lookup as SessionGuard (user row is read fresh, so a role change applies at once), then role=admin.
// Everyone else, including anonymous callers, gets 404: the admin routes do not reveal themselves.
@Injectable()
export class AdminGuard implements CanActivate {
  private logger = new Logger('Admin');

  constructor(private auth: AuthService) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const user = await this.auth.userForSession(req.cookies?.[SESSION_COOKIE]);
    if (!user || user.role !== 'admin') throw new NotFoundException();
    req.user = user;
    this.logger.log(`admin ${user.id} ${req.method} ${String(req.originalUrl ?? req.url).split('?')[0]}`);
    return true;
  }
}
