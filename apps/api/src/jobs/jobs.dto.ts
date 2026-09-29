import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { PageQueryDto } from '../pagination';
import { FRACTIONS, LANGUAGES, METHOD_MESSAGE, METHOD_RE } from './options';

export class CreateJobDto {
  @IsUUID()
  documentId: string;

  @IsIn(LANGUAGES)
  language: (typeof LANGUAGES)[number];

  @IsIn(FRACTIONS)
  fraction: (typeof FRACTIONS)[number];

  @Matches(METHOD_RE, { message: METHOD_MESSAGE })
  method: string;

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
