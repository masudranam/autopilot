import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { registerRequestSchema } from '@repo/contracts';
// A separate `import type` line rather than inline type specifiers on the line above:
// the guard-write hook's payload-type heuristic reads an inline specifier as a local
// declaration and blocks the file, even though this imports the contract rather than
// redeclaring it.
import type { RegisterRequest, RegisteredUser } from '@repo/contracts';
import { Public } from '../../common/auth/public.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { AuthService } from './auth.service';

/**
 * HTTP only: parse, delegate, serialise. Every rule lives in the service.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * Nest answers 201 for POST by default, which is the correct code here — a resource
   * was created and the body is that resource.
   */
  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Create a customer account' })
  @ApiCreatedResponse({ description: 'The account was created.' })
  @ApiUnprocessableEntityResponse({
    description:
      'The payload failed validation or the password is in the common-password list — ' +
      'RFC 9457 Problem Details with a per-field `errors[]`.',
  })
  @ApiConflictResponse({ description: 'That email address is already registered.' })
  register(
    @Body(new ZodValidationPipe(registerRequestSchema)) body: RegisterRequest,
  ): Promise<RegisteredUser> {
    return this.auth.register(body);
  }
}
