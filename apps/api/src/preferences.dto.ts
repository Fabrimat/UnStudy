import { Type } from 'class-transformer';
import { ArrayMaxSize, IsEnum, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { LegalKind } from '@summarize/db';
import { FRACTIONS, LANGUAGES, LENGTH_MAX, LENGTH_MIN, METHOD_MESSAGE, METHOD_RE } from './jobs/options';

// IsOptional also skips null: null means "remove this preference".
export class PreferencesDto {
  @IsOptional()
  @IsIn(LANGUAGES)
  language?: (typeof LANGUAGES)[number] | null;

  @IsOptional()
  @IsIn(FRACTIONS)
  fraction?: (typeof FRACTIONS)[number] | null;

  @IsOptional()
  @IsInt()
  @Min(LENGTH_MIN)
  @Max(LENGTH_MAX)
  lengthPercent?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  model?: string | null;

  @IsOptional()
  @Matches(METHOD_RE, { message: METHOD_MESSAGE })
  method?: string | null;
}

export class LegalRefDto {
  @IsEnum(LegalKind)
  kind: LegalKind;

  @IsInt()
  @Min(1)
  version: number;
}

export class AcceptLegalDto {
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => LegalRefDto)
  documents: LegalRefDto[];
}

export class DeleteAccountDto {
  @IsString()
  @MaxLength(320)
  confirm: string;
}
