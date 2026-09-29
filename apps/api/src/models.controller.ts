import { Controller, Get, UseGuards } from '@nestjs/common';
import { SessionGuard } from './auth/session.guard';
import { CatalogService } from './catalog/catalog.service';

@Controller('models')
@UseGuards(SessionGuard)
export class ModelsController {
  constructor(private catalog: CatalogService) {}

  // adminOnly models are hidden. The provider's model id never leaves the server.
  @Get()
  async list() {
    return (await this.catalog.userModels()).map(({ id, label, multiplier }) => ({ id, label, multiplier }));
  }
}
