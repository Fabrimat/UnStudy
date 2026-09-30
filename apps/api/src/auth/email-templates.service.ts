import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { User } from '@summarize/db';
import { PrismaService } from '../prisma.service';
import { EMAIL_TEMPLATES, fill, tokensOf } from './email-templates';

@Injectable()
export class EmailTemplatesService {
  private logger = new Logger('Admin');

  constructor(private prisma: PrismaService) {}

  private def(key: string) {
    const d = Object.hasOwn(EMAIL_TEMPLATES, key) ? EMAIL_TEMPLATES[key] : undefined;
    if (!d) throw new NotFoundException('Unknown email template');
    return d;
  }

  // Override if present, else default. Never throws on a broken override: a login email must still go out.
  async render(key: string, vars: Record<string, string>) {
    const d = this.def(key);
    try {
      const row = await this.prisma.emailTemplate.findUnique({ where: { key } });
      if (row) return { subject: fill(row.subject, vars), body: fill(row.body, vars) };
    } catch (e) {
      this.logger.error(`Email template ${key}: override unusable, sending the default (${(e as Error).message})`);
    }
    return { subject: fill(d.subject, vars), body: fill(d.body, vars) };
  }

  private validate(key: string, subject: string, body: string) {
    const d = this.def(key);
    const inSubject = tokensOf(subject);
    const inBody = tokensOf(body);
    const known = new Set(d.placeholders.map((p) => p.name));
    const unknown = [...new Set([...inSubject, ...inBody])].filter((t) => !known.has(t));
    if (unknown.length) throw new BadRequestException(`Unknown placeholder(s): ${unknown.map((t) => `{${t}}`).join(', ')}`);
    // {link} is what the reader must click: it has to be in the body, not only the subject
    const missing = d.placeholders.filter((p) => p.required && !(p.name === 'link' ? inBody : [...inSubject, ...inBody]).includes(p.name));
    if (missing.length) throw new BadRequestException(`Missing required placeholder(s): ${missing.map((p) => `{${p.name}}`).join(', ')}`);
  }

  async list() {
    const rows = new Map((await this.prisma.emailTemplate.findMany()).map((r) => [r.key, r]));
    return Object.entries(EMAIL_TEMPLATES).map(([key, d]) => {
      const row = rows.get(key);
      return {
        key,
        placeholders: d.placeholders,
        subject: row?.subject ?? d.subject,
        body: row?.body ?? d.body,
        isDefault: !row,
        updatedAt: row?.updatedAt ?? null,
        defaultSubject: d.subject,
        defaultBody: d.body,
      };
    });
  }

  async save(user: User, key: string, subject: string, body: string) {
    this.validate(key, subject, body);
    await this.prisma.emailTemplate.upsert({
      where: { key },
      create: { key, subject, body, updatedById: user.id },
      update: { subject, body, updatedById: user.id },
    });
    this.logger.log(`Email template ${key} saved by admin ${user.id}`);
    return (await this.list()).find((t) => t.key === key);
  }

  preview(key: string, subject: string, body: string) {
    this.validate(key, subject, body);
    const { sample } = this.def(key);
    return { subject: fill(subject, sample), body: fill(body, sample) };
  }

  async reset(user: User, key: string) {
    this.def(key);
    await this.prisma.emailTemplate.deleteMany({ where: { key } });
    this.logger.log(`Email template ${key} reset to default by admin ${user.id}`);
  }
}
