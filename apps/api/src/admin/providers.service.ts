import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, User } from '@summarize/db';
import { CatalogService } from '../catalog/catalog.service';
import { PrismaService } from '../prisma.service';
import { CreateProviderDto, UpdateProviderDto } from './admin.dto';

const CATALOG_LOCK = 726001;

// keyEnv is informational and computed: the DB never stores a key or an env var name.
export const providerView = ({ id, baseUrl, tokenParam, maxConcurrency }: { id: string; baseUrl: string; tokenParam: string; maxConcurrency: number | null }) => ({
  id, baseUrl, tokenParam, maxConcurrency, keyEnv: 'LLM_KEY_' + id.toUpperCase().replace(/-/g, '_'),
});

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
    return (await this.prisma.llmProvider.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(providerView);
  }

  async create(admin: User, dto: CreateProviderDto) {
    const row = await this.write(async (tx) => {
      if (await tx.llmProvider.findUnique({ where: { id: dto.id } })) throw new ConflictException('Provider id already exists');
      return tx.llmProvider.create({
        data: { id: dto.id, baseUrl: dto.baseUrl, tokenParam: dto.tokenParam ?? 'max_tokens', maxConcurrency: dto.maxConcurrency ?? null },
      });
    });
    this.logger.log(`Provider created: admin ${admin.id}, ${row.id}, ${host(row.baseUrl)}`);
    return providerView(row);
  }

  async update(admin: User, id: string, dto: UpdateProviderDto) {
    const row = await this.write(async (tx) => {
      if (!(await tx.llmProvider.findUnique({ where: { id } }))) throw new NotFoundException('Provider not found');
      return tx.llmProvider.update({ where: { id }, data: { ...dto } });
    });
    this.logger.log(`Provider updated: admin ${admin.id}, ${id}, ${host(row.baseUrl)}, fields ${Object.keys(dto).join(',') || '-'}`);
    return providerView(row);
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
