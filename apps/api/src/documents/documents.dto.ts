import { IsInt, IsString, Length, Matches, Max, Min } from 'class-validator';

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
