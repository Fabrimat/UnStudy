import { Controller, Get, UseGuards } from '@nestjs/common';
import { SessionGuard } from './auth/session.guard';
import { config } from './config';

@Controller('models')
@UseGuards(SessionGuard)
export class ModelsController {
  // The provider's model id never leaves the server.
  @Get()
  list() {
    return config.models.map(({ id, label, multiplier }) => ({ id, label, multiplier }));
  }
}
