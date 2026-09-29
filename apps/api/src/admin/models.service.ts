import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, User } from '@summarize/db';
import { CatalogService } from '../catalog/catalog.service';
import { config } from '../config';
import { PrismaService } from '../prisma.service';
import { CreateModelDto, UpdateModelDto } from './admin.dto';

const CATALOG_LOCK = 726001;

const view = ({ id, label, provider, model, multiplier, temperature, priceIn, priceOut, adminOnly, enabled, position }: {
  id: string; label: string; provider: string; model: string; multiplier: number; temperature: number | null;
  priceIn?: number | null; priceOut?: number | null; adminOnly: boolean; enabled: boolean; position: number;
}) => ({ id, label, provider, model, multiplier, temperature, priceIn: priceIn ?? null, priceOut: priceOut ?? null, adminOnly, enabled, position });

const checkProvider = (id: string) => {
  if (!config.providers.some((p) => p.id === id)) throw new BadRequestException('Unknown provider');
};

@Injectable()
export class ModelsAdminService {
  private logger = new Logger(ModelsAdminService.name);

  constructor(private prisma: PrismaService, private catalog: CatalogService) {}

  // Never includes apiKeyEnv or any key.
  async list() {
    return {
      providers: config.providers.map(({ id, kind, baseUrl }) => ({ id, kind, baseUrl })),
      models: (await this.catalog.all()).map(view),
    };
  }

  async create(admin: User, dto: CreateModelDto) {
    checkProvider(dto.provider);
    const row = await this.write(async (tx) => {
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
    if (dto.provider !== undefined) checkProvider(dto.provider);
    const row = await this.write(async (tx) => {
      if (!(await tx.modelPreset.findUnique({ where: { id } }))) throw new NotFoundException('Model not found');
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
