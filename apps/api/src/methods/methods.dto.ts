import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, Matches } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateMethodDto {
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  @Matches(/^[^\r\n]*$/, { message: 'name must be a single line' })
  name: string;

  @Transform(trim)
  @IsString()
  @Length(1, 4000)
  instructions: string;
}

export class UpdateMethodDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  @Matches(/^[^\r\n]*$/, { message: 'name must be a single line' })
  name?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 4000)
  instructions?: string;
}
