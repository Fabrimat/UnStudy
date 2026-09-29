import { IsString, MaxLength } from 'class-validator';

export class CheckoutDto {
  @IsString()
  @MaxLength(32)
  packId!: string;
}
