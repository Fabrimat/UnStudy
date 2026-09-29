import { ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { PageQueryDto } from '../pagination';
import { EXTRAS, LANGUAGES, LENGTH_MAX, LENGTH_MIN, METHOD_MESSAGE, METHOD_RE } from './options';

// Settings shared by user jobs and admin Lab runs.
export class JobSettingsDto {
  @IsUUID()
  documentId: string;

  @IsIn(LANGUAGES)
  language: (typeof LANGUAGES)[number];

  @IsInt()
  @Min(LENGTH_MIN)
  @Max(LENGTH_MAX)
  lengthPercent: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  chapters?: number[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(EXTRAS, { each: true })
  extras?: (typeof EXTRAS)[number][];

  @Matches(METHOD_RE, { message: METHOD_MESSAGE })
  method: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  @Matches(/^[^\r\n]*$/, { message: 'bibliographicLine must be a single line' })
  bibliographicLine?: string;
}

export class CreateJobDto extends JobSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  model?: string;
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
