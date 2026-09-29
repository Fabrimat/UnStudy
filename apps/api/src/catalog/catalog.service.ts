import { BadRequestException, Injectable } from '@nestjs/common';
import { ModelPreset, Prisma } from '@summarize/db';
import { config, ModelEntry } from '../config';
import { PrismaService } from '../prisma.service';

export type CatalogEntry = ModelEntry & { enabled: boolean; position: number };

const TTL_MS = 5000;
// Module-level so tests (resetDb) can drop it without reaching into a Nest instance.
let cache: { at: number; entries: CatalogEntry[] } | null = null;
export const invalidateCatalog = () => {
  cache = null;
};

const toEntry = (r: ModelPreset): CatalogEntry => ({
  id: r.id,
  label: r.label,
  provider: r.provider,
  model: r.model,
  multiplier: r.multiplier,
  temperature: r.temperature,
  ...(r.priceIn !== null && { priceIn: r.priceIn }),
  ...(r.priceOut !== null && { priceOut: r.priceOut }),
  adminOnly: r.adminOnly,
  enabled: r.enabled,
  position: r.position,
});

// Editable model catalog (ModelPreset). An empty table is seeded from the LLM_MODELS env catalog on first read.
@Injectable()
export class CatalogService {
  constructor(private prisma: PrismaService) {}

  invalidate() {
    invalidateCatalog();
  }

  // Idempotent and multi-instance safe: skipDuplicates. Also called inside admin write transactions.
  async ensureSeeded(tx: Prisma.TransactionClient = this.prisma) {
    if (await tx.modelPreset.count()) return;
    await tx.modelPreset.createMany({
      data: config.models.map((m, position) => ({
        id: m.id, label: m.label, provider: m.provider, model: m.model, multiplier: m.multiplier, temperature: m.temperature,
        priceIn: m.priceIn ?? null, priceOut: m.priceOut ?? null, adminOnly: m.adminOnly, enabled: true, position,
      })),
      skipDuplicates: true,
    });
  }

  async all(): Promise<CatalogEntry[]> {
    if (cache && Date.now() - cache.at < TTL_MS) return cache.entries;
    await this.ensureSeeded();
    const rows = await this.prisma.modelPreset.findMany({ orderBy: [{ position: 'asc' }, { id: 'asc' }] });
    const entries = rows.map(toEntry);
    cache = { at: Date.now(), entries };
    return entries;
  }

  // What users may pick; the first one is their default.
  async userModels() {
    return (await this.all()).filter((m) => m.enabled && !m.adminOnly);
  }

  async labModels() {
    return (await this.all()).filter((m) => m.enabled);
  }

  // Any row, disabled included (cost of past runs, labels).
  async find(id: string) {
    return (await this.all()).find((m) => m.id === id);
  }

  // User-facing pick (undefined = default). adminOnly is indistinguishable from unknown; disabled has its own message.
  async userModel(id?: string): Promise<CatalogEntry> {
    if (id === undefined) return (await this.userModels())[0];
    const e = await this.find(id);
    if (!e || e.adminOnly) throw new BadRequestException('Unknown model');
    if (!e.enabled) throw new BadRequestException('Model no longer available');
    return e;
  }

  async labModel(id: string): Promise<CatalogEntry> {
    const e = await this.find(id);
    if (!e) throw new BadRequestException('Unknown model');
    if (!e.enabled) throw new BadRequestException('Model no longer available');
    return e;
  }
}
