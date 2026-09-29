import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, MaxLength, ValidateIf, ValidateNested } from 'class-validator';
import { JobSettingsDto } from '../jobs/jobs.dto';
import { PageQueryDto } from '../pagination';

export const MAX_LANES = 8;

export class LaneDto {
  @IsString()
  @MaxLength(32)
  draft: string;

  // null = skip the fact-check pass for this lane
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(32)
  verify: string | null;
}

export class CreateBenchmarkDto extends JobSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LANES)
  @ValidateNested({ each: true })
  @Type(() => LaneDto)
  lanes: LaneDto[];
}

export class ListBenchmarksDto extends PageQueryDto {}

