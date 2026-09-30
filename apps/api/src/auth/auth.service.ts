import { HttpException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { AuthProvider, User } from '@summarize/db';
import { config } from '../config';
import { PrismaService } from '../prisma.service';
import { maskEmail } from './mask-email';
import { EmailTemplatesService } from './email-templates.service';
import { MailService } from './mail.service';
import { randomToken, sha256 } from './tokens';

const MAGIC_LINK_TTL_MS = 15 * 60_000;
const MAX_LINKS_PER_HOUR = 5;
export const SESSION_TTL_MS = 30 * 24 * 3600_000;

const normalizeEmail = (email: string) => email.trim().toLowerCase();

@Injectable()
export class AuthService {
  private logger = new Logger(AuthService.name);

  constructor(private prisma: PrismaService, private mail: MailService, private templates: EmailTemplatesService) {}

  async requestMagicLink(rawEmail: string) {
    const email = normalizeEmail(rawEmail);
    const token = randomToken();
    await this.prisma.$transaction(async (tx) => {
      // Serialize concurrent requests for the same email so the count-then-create rate check can't race.
      // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void, which $queryRaw can't deserialize.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${email}))`;
      const recent = await tx.magicLinkToken.count({
        where: { email, createdAt: { gt: new Date(Date.now() - 3600_000) } },
      });
      if (recent >= MAX_LINKS_PER_HOUR) {
        this.logger.warn(`Login link rate-limited: ${maskEmail(email)}`);
        throw new HttpException('Too many login links requested, try again later', 429);
      }
      await tx.magicLinkToken.create({
        data: { tokenHash: sha256(token), email, expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS) },
      });
    });
    this.logger.log(`Login link requested: ${maskEmail(email)}`);
    // Sent after the transaction commits so SMTP latency never holds the advisory lock.
    // The link opens a web page that POSTs the token: mail scanners that prefetch GET links cannot burn it.
    const link = `${config.webOrigin}/auth/verify?token=${token}`;
    const { subject, body } = await this.templates.render('magic_link', { link, email });
    await this.mail.send(email, subject, body);
  }

  async verifyMagicLink(token: string): Promise<string> {
    const tokenHash = sha256(token);
    const { count } = await this.prisma.magicLinkToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (count !== 1) throw new UnauthorizedException('Invalid or expired link');
    const { email } = await this.prisma.magicLinkToken.findUniqueOrThrow({ where: { tokenHash } });
    const user = await this.loginWithProvider('email', email, email, true);
    const session = await this.createSession(user.id);
    this.logger.log(`Login succeeded (magic link): user ${user.id}`);
    return session;
  }

  async loginWithProvider(provider: AuthProvider, providerAccountId: string, rawEmail: string, emailVerified: boolean): Promise<User> {
    const email = normalizeEmail(rawEmail);
    const account = await this.prisma.authAccount.findUnique({
      where: { provider_providerAccountId: { provider, providerAccountId } },
      include: { user: true },
    });
    if (account) return account.user;
    // Linking by email is only safe when the provider vouches for the address.
    if (!emailVerified) throw new UnauthorizedException('Email not verified by the login provider');
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.upsert({ where: { email }, update: {}, create: { email } });
      await tx.authAccount.create({ data: { userId: user.id, provider, providerAccountId } });
      return user;
    });
  }

  async createSession(userId: string): Promise<string> {
    const token = randomToken();
    await this.prisma.session.create({
      data: { id: sha256(token), userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
    });
    return token;
  }

  async userForSession(token?: string): Promise<User | null> {
    if (!token) return null;
    const session = await this.prisma.session.findUnique({ where: { id: sha256(token) }, include: { user: true } });
    if (!session || session.expiresAt < new Date() || session.user.deletedAt) return null;
    return session.user;
  }

  async logout(token?: string) {
    if (!token) return;
    const { count } = await this.prisma.session.deleteMany({ where: { id: sha256(token) } });
    if (count) this.logger.log('Logout');
  }
}
