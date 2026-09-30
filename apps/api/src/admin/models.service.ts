import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, User } from '@summarize/db';
import { CatalogService } from '../catalog/catalog.service';
import { PrismaService } from '../prisma.service';
import { CreateModelDto, UpdateModelDto } from './admin.dto';
import { listProviders } from './providers.service';

const CATALOG_LOCK = 726001;

const view = ({ id, label, provider, model, multiplier, temperature, priceIn, priceOut, adminOnly, enabled, position }: {
  id: string; label: string; provider: string; model: string; multiplier: number; temperature: number | null;
  priceIn?: number | null; priceOut?: number | null; adminOnly: boolean; enabled: boolean; position: number;
}) => ({ id, label, provider, model, multiplier, temperature, priceIn: priceIn ?? null, priceOut: priceOut ?? null, adminOnly, enabled, position });

const checkProvider = async (tx: Prisma.TransactionClient, id: string) => {
  if (!(await tx.llmProvider.findUnique({ where: { id } }))) throw new BadRequestException('Unknown provider');
};

@Injectable()
export class ModelsAdminService {
  private logger = new Logger(ModelsAdminService.name);

  constructor(private prisma: PrismaService, private catalog: CatalogService) {}

  // Never includes any key.
  async list() {
    const models = (await this.catalog.all()).map(view); // seeds providers too
    return { providers: await listProviders(this.prisma), models };
  }

  async create(admin: User, dto: CreateModelDto) {
    const row = await this.write(async (tx) => {
      await checkProvider(tx, dto.provider);
      if (await tx.modelPreset.findUnique({ where: { id: dto.id } })) throw new ConflictException('Model id already exists');
      const last = await tx.modelPreset.aggregate({ _max: { position: true } });
      return tx.modelPreset.create({
        data: {
          id: dto.id, label: dto.label, provider: dto.provider, model: dto.model, multiplier: dto.multiplier,
          temperature: dto.temperature === undefined ? 0.4 : dto.temperature,
          priceIn: dto.priceIn ?? null, priceOut: dto.priceOut ?? null,
          adminOnly: dto.adminOnly ?? false, enabled: dto.enabled ?? true,
          position: dto.position ?? (last._max.position ?? -1) + 1,
        },
      });
    });
    this.logger.log(`Model created: admin ${admin.id}, ${row.id}`);
    return view(row);
  }

  async update(admin: User, id: string, dto: UpdateModelDto) {
    const row = await this.write(async (tx) => {
      const cur = await tx.modelPreset.findUnique({ where: { id } });
      if (!cur) throw new NotFoundException('Model not found');
      if (dto.provider !== undefined && dto.provider !== cur.provider) await checkProvider(tx, dto.provider);
      return tx.modelPreset.update({ where: { id }, data: { ...dto } });
    });
    this.logger.log(`Model updated: admin ${admin.id}, ${id}, fields ${Object.keys(dto).join(',') || '-'}`);
    return view(row);
  }

  async order(admin: User, ids: string[]) {
    await this.write(async (tx) => {
      const rows = await tx.modelPreset.findMany({ select: { id: true } });
      const known = new Set(rows.map((r) => r.id));
      if (new Set(ids).size !== ids.length || ids.length !== known.size || ids.some((i) => !known.has(i))) {
        throw new BadRequestException('ids must be a permutation of all model ids');
      }
      for (const [position, id] of ids.entries()) await tx.modelPreset.update({ where: { id }, data: { position } });
    });
    this.logger.log(`Models reordered: admin ${admin.id}`);
    return this.list();
  }

  // Serialised catalog write: advisory lock, seed if empty, mutate, then re-check the invariant
  // (at least one enabled, user-visible model); a broken invariant rolls the whole thing back.
  private async write<T>(mutate: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CATALOG_LOCK})`;
        await this.catalog.ensureSeeded(tx);
        const result = await mutate(tx);
        if (!(await tx.modelPreset.count({ where: { enabled: true, adminOnly: false } }))) {
          throw new ConflictException('At least one enabled model must remain available to users');
        }
        return result;
      });
    } finally {
      this.catalog.invalidate();
    }
  }
}
