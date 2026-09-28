import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { FRACTIONS, LANGUAGES, PRESETS } from './options';

export class CreateJobDto {
  @IsUUID()
  documentId: string;

  @IsIn(LANGUAGES)
  language: (typeof LANGUAGES)[number];

  @IsIn(FRACTIONS)
  fraction: (typeof FRACTIONS)[number];

  @IsIn(PRESETS)
  preset: (typeof PRESETS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(300)
  @Matches(/^[^\r\n]*$/, { message: 'bibliographicLine must be a single line' })
  bibliographicLine?: string;
}
