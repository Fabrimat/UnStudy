import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, User } from '@summarize/db';
import { CatalogService } from '../catalog/catalog.service';
import { PrismaService } from '../prisma.service';
import { CreateProviderDto, UpdateProviderDto } from './admin.dto';

const CATALOG_LOCK = 726001;

// keyEnv is informational and computed: the DB never stores a key or an env var name.
// The worker reports presence only (ProviderKeyStatus); no report, or one older than this, means unknown.
const KEY_STALE_MS = 15 * 60_000;
type KeyStatus = { hasKey: boolean; source: string; checkedAt: Date };

const keyView = (s?: KeyStatus | null) => ({
  status: !s || Date.now() - s.checkedAt.getTime() > KEY_STALE_MS ? ('unknown' as const) : s.hasKey ? ('ok' as const) : ('missing' as const),
  source: (s?.source ?? null) as 'LLM_KEY' | 'LLM_PROVIDERS' | 'none' | null,
  checkedAt: s?.checkedAt.toISOString() ?? null,
});

export const providerView = (
  { id, baseUrl, tokenParam, maxConcurrency }: { id: string; baseUrl: string; tokenParam: string; maxConcurrency: number | null },
  status?: KeyStatus | null,
) => ({
  id, baseUrl, tokenParam, maxConcurrency, keyEnv: 'LLM_KEY_' + id.toUpperCase().replace(/-/g, '_'), key: keyView(status),
});

// Two queries joined in memory (no FK: env-only providers are reported too).
export const listProviders = async (prisma: PrismaService) => {
  const [rows, statuses] = await Promise.all([
    prisma.llmProvider.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    prisma.providerKeyStatus.findMany(),
  ]);
  const byId = new Map(statuses.map((s) => [s.id, s]));
  return rows.map((r) => providerView(r, byId.get(r.id)));
};

const host = (baseUrl: string) => {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
};

@Injectable()
export class ProvidersAdminService {
  private logger = new Logger(ProvidersAdminService.name);

  constructor(private prisma: PrismaService, private catalog: CatalogService) {}

  async list() {
    await this.catalog.ensureSeeded();
    return listProviders(this.prisma);
  }

  async create(admin: User, dto: CreateProviderDto) {
    const row = await this.write(async (tx) => {
      if (await tx.llmProvider.findUnique({ where: { id: dto.id } })) throw new ConflictException('Provider id already exists');
      return tx.llmProvider.create({
        data: { id: dto.id, baseUrl: dto.baseUrl, tokenParam: dto.tokenParam ?? 'max_tokens', maxConcurrency: dto.maxConcurrency ?? null },
      });
    });
    this.logger.log(`Provider created: admin ${admin.id}, ${row.id}, ${host(row.baseUrl)}`);
    return providerView(row, await this.prisma.providerKeyStatus.findUnique({ where: { id: row.id } }));
  }

  async update(admin: User, id: string, dto: UpdateProviderDto) {
    const row = await this.write(async (tx) => {
      if (!(await tx.llmProvider.findUnique({ where: { id } }))) throw new NotFoundException('Provider not found');
      return tx.llmProvider.update({ where: { id }, data: { ...dto } });
    });
    this.logger.log(`Provider updated: admin ${admin.id}, ${id}, ${host(row.baseUrl)}, fields ${Object.keys(dto).join(',') || '-'}`);
    return providerView(row, await this.prisma.providerKeyStatus.findUnique({ where: { id } }));
  }

  async remove(admin: User, id: string) {
    await this.write(async (tx) => {
      if (!(await tx.llmProvider.findUnique({ where: { id } }))) throw new NotFoundException('Provider not found');
      if (await tx.modelPreset.count({ where: { provider: id } })) throw new ConflictException('Provider is used by models');
      await tx.llmProvider.delete({ where: { id } });
    });
    this.logger.log(`Provider deleted: admin ${admin.id}, ${id}`);
  }

  // Same lock as the model catalog writes, so a model create cannot race a provider delete.
  private async write<T>(mutate: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CATALOG_LOCK})`;
      await this.catalog.ensureSeeded(tx);
      return mutate(tx);
    });
  }
}
