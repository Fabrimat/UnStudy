import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, NotEquals,
  ValidateIf, ValidateNested,
} from 'class-validator';
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


// --- model catalog ---
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateModelDto {
  @Matches(/^[a-z0-9-]{1,32}$/, { message: 'id must be a-z, 0-9, dash, max 32' })
  id: string;

  @Transform(trim)
  @IsString()
  @Length(1, 80)
  label: string;

  @IsString()
  @Length(1, 32)
  provider: string;

  @Transform(trim)
  @IsString()
  @Length(1, 200)
  model: string;

  @IsNumber()
  @Min(0.01)
  @Max(100)
  multiplier: number;

  // null = do not send temperature; IsOptional skips null and undefined
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  priceIn?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  priceOut?: number | null;

  @IsOptional()
  @IsBoolean()
  adminOnly?: boolean;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}

// Any subset except id. Non-nullable fields must not be null, so they use ValidateIf(!== undefined) instead of IsOptional.
const set = (v: unknown) => v !== undefined;
export class UpdateModelDto {
  @ValidateIf((_, v) => set(v))
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  label?: string;

  @ValidateIf((_, v) => set(v))
  @IsString()
  @Length(1, 32)
  provider?: string;

  @ValidateIf((_, v) => set(v))
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  model?: string;

  @ValidateIf((_, v) => set(v))
  @IsNumber()
  @Min(0.01)
  @Max(100)
  multiplier?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  priceIn?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  priceOut?: number | null;

  @ValidateIf((_, v) => set(v))
  @IsBoolean()
  adminOnly?: boolean;

  @ValidateIf((_, v) => set(v))
  @IsBoolean()
  enabled?: boolean;

  @ValidateIf((_, v) => set(v))
  @IsInt()
  @Min(0)
  position?: number;
}

export class ModelOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  ids: string[];
}

// --- users ---
export class ListUsersDto extends PageQueryDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  q?: string;
}

export class CreditsDto {
  @IsInt()
  @Min(-100000)
  @Max(100000)
  @NotEquals(0)
  amount: number;

  @Transform(trim)
  @IsString()
  @Length(1, 200)
  note: string;
}

// --- documents / jobs ---
export class ListAdminDocumentsDto extends PageQueryDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  q?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsIn(['uploaded', 'analyzed', 'rejected'])
  status?: 'uploaded' | 'analyzed' | 'rejected';
}

export class ListAdminJobsDto extends PageQueryDto {
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsUUID()
  documentId?: string;

  @IsOptional()
  @IsIn(['queued', 'running', 'done', 'failed'])
  status?: 'queued' | 'running' | 'done' | 'failed';

  @IsOptional()
  @IsIn(['analyze', 'summarize'])
  kind?: 'analyze' | 'summarize';

  @IsOptional()
  @IsIn(['true', 'false'])
  lab?: 'true' | 'false';
}

export class StatsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days: number = 30;
}
