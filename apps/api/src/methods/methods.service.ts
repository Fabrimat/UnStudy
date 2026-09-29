import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SummaryMethod, User } from '@summarize/db';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_METHODS, PRESETS } from '../jobs/options';
import { PrismaService } from '../prisma.service';
import { CreateMethodDto, UpdateMethodDto } from './methods.dto';

// apps/api/{src,dist}/methods -> apps/worker/...; same depth in dev, build and the Docker image.
const PRESETS_DIR = join(__dirname, '../../../worker/summarize_worker/presets');

const toDto = ({ id, name, instructions, createdAt, updatedAt }: SummaryMethod) => ({ id, name, instructions, createdAt, updatedAt });

@Injectable()
export class MethodsService {
  private logger = new Logger(MethodsService.name);
  // Read once at construction: a missing file throws and stops the boot (fail fast).
  readonly presets = PRESETS.map((id) => ({ id, text: readFileSync(join(PRESETS_DIR, `${id}.md`), 'utf-8') }));

  constructor(private prisma: PrismaService) {}

  async list(user: User) {
    // ponytail: capped at MAX_METHODS per user, so no pagination.
    const rows = await this.prisma.summaryMethod.findMany({ where: { userId: user.id }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] });
    return rows.map(toDto);
  }

  async create(user: User, dto: CreateMethodDto) {
    const m = await this.prisma.$transaction(async (tx) => {
      // Same user lock as JobsService.create, so concurrent POSTs cannot exceed the cap.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id}::uuid FOR UPDATE`;
      if ((await tx.summaryMethod.count({ where: { userId: user.id } })) >= MAX_METHODS) {
        throw new ConflictException(`You can have at most ${MAX_METHODS} methods`);
      }
      return tx.summaryMethod.create({ data: { userId: user.id, ...dto } });
    });
    this.logger.log(`Method created: user ${user.id}, method ${m.id}, ${m.instructions.length} chars`);
    return toDto(m);
  }

  async update(user: User, id: string, dto: UpdateMethodDto) {
    await this.findOwned(user, id);
    const m = await this.prisma.summaryMethod.update({ where: { id }, data: dto });
    this.logger.log(`Method updated: user ${user.id}, method ${id}, ${m.instructions.length} chars`);
    return toDto(m);
  }

  async remove(user: User, id: string) {
    await this.findOwned(user, id);
    await this.prisma.summaryMethod.delete({ where: { id } });
    this.logger.log(`Method deleted: user ${user.id}, method ${id}`);
  }

  private async findOwned(user: User, id: string) {
    const m = await this.prisma.summaryMethod.findFirst({ where: { id, userId: user.id } });
    if (!m) throw new NotFoundException('Method not found');
    return m;
  }
}
