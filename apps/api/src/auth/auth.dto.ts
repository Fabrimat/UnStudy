import { IsEmail, IsString, Length, MaxLength } from 'class-validator';

export class MagicLinkDto {
  @IsEmail()
  @MaxLength(254)
  email: string;
}

export class VerifyDto {
  @IsString()
  @Length(20, 100)
  token: string;
}
