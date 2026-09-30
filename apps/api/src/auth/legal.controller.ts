import { Controller, Get, NotFoundException, Param, ParseEnumPipe } from '@nestjs/common';
import { LegalKind } from '@summarize/db';
import { LegalService } from './legal.service';

// Public: the texts must be readable before login.
@Controller('legal')
export class LegalController {
  constructor(private legal: LegalService) {}

  @Get(':kind')
  current(@Param('kind', new ParseEnumPipe(LegalKind, { exceptionFactory: () => new NotFoundException() })) kind: LegalKind) {
    return this.legal.publicCurrent(kind);
  }
}
