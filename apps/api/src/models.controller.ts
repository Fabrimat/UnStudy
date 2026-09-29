import { Controller, Get, UseGuards } from '@nestjs/common';
import { SessionGuard } from './auth/session.guard';
import { config } from './config';

@Controller('models')
@UseGuards(SessionGuard)
export class ModelsController {
  // adminOnly models are hidden. The provider's model id never leaves the server.
  @Get()
  list() {
    return config.userModels.map(({ id, label, multiplier }) => ({ id, label, multiplier }));
  }
}
