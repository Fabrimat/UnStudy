import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { PageQueryDto } from '../pagination';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export class CreateDocumentDto {
  @IsString()
  @Length(5, 255)
  @Matches(/\.pdf$/i, { message: 'Only PDF files are supported' })
  filename: string;

  @IsInt()
  @Min(1)
  @Max(MAX_UPLOAD_BYTES, { message: 'File larger than 50 MB' })
  sizeBytes: number;
}

export class RenameDocumentDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 200)
  @Matches(/^[^\r\n]*$/, { message: 'filename must be a single line' })
  filename: string;
}

export class ListDocumentsDto extends PageQueryDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  q?: string;

  @IsOptional()
  @IsIn(['analyzing', 'ready', 'rejected', 'summarized'])
  status?: 'analyzing' | 'ready' | 'rejected' | 'summarized';

  @IsOptional()
  @IsIn(['createdAt', 'filename'])
  sort: 'createdAt' | 'filename' = 'createdAt';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order: 'asc' | 'desc' = 'desc';
}
