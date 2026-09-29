import { IsIn, IsOptional, Matches } from 'class-validator';
import { FRACTIONS, LANGUAGES, METHOD_MESSAGE, METHOD_RE } from './jobs/options';

// IsOptional also skips null: null means "remove this preference".
export class PreferencesDto {
  @IsOptional()
  @IsIn(LANGUAGES)
  language?: (typeof LANGUAGES)[number] | null;

  @IsOptional()
  @IsIn(FRACTIONS)
  fraction?: (typeof FRACTIONS)[number] | null;

  @IsOptional()
  @Matches(METHOD_RE, { message: METHOD_MESSAGE })
  method?: string | null;
}
