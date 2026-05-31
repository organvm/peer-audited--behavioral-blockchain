import { IsString, IsOptional } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CrisisEscalateDto {
  @ApiProperty({
    description: "User ID to escalate crisis for",
    example: "user_abc123",
  })
  @IsString()
  userId!: string;

  @ApiPropertyOptional({
    description: "Trigger text that caused the crisis detection",
    example: "I want to hurt myself",
  })
  @IsOptional()
  @IsString()
  trigger?: string;
}
