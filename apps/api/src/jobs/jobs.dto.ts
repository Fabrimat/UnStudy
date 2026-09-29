import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { PageQueryDto } from '../pagination';
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

export class ListJobsDto extends PageQueryDto {
  @IsOptional()
  @IsIn(['queued', 'running', 'done', 'failed'])
  status?: 'queued' | 'running' | 'done' | 'failed';

  @IsOptional()
  @IsString()
  @MaxLength(50)
  method?: string;

  @IsOptional()
  @IsUUID()
  documentId?: string;

  @IsOptional()
  @IsIn(['true'])
  active?: 'true';
}
