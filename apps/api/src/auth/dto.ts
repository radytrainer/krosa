import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ description: 'Admin username or student ID', example: 'GEN26-0001' })
  @IsString()
  @Length(1, 64)
  identifier!: string;

  @ApiProperty({ format: 'password' })
  @IsString()
  @Length(1, 256)
  password!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ format: 'password' })
  @IsString()
  @Length(1, 256)
  currentPassword!: string;

  @ApiProperty({ format: 'password', minLength: 10, maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  newPassword!: string;
}

export interface MeResponse {
  id: string;
  role: 'ADMIN' | 'STUDENT';
  username: string;
  displayName: string | null;
  mustChangePassword: boolean;
  student: { id: string; studentCode: string; fullName: string } | null;
}
