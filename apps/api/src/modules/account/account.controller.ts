import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  addressIdSchema,
  createAddressRequestSchema,
  updateAddressRequestSchema,
  updateProfileRequestSchema,
} from '@repo/contracts';
// A separate `import type` line rather than inline specifiers: the guard-write hook's
// payload-type heuristic reads an inline specifier as a local declaration and blocks the
// file, even though this imports the contract rather than redeclaring it.
import type {
  AccessTokenClaims,
  Address,
  CreateAddressRequest,
  Profile,
  UpdateAddressRequest,
  UpdateProfileRequest,
} from '@repo/contracts';
import { Authenticated } from '../../common/auth/authenticated.decorator';
import type { RequestWithAuth } from '../../common/auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { AccountService } from './account.service';

/**
 * HTTP only: parse, delegate, serialise. Every rule lives in the service.
 *
 * Every route is `@Authenticated()`. None takes a user id — the caller is the token's
 * `sub`, so there is no path parameter through which one account could name another
 * (I4). The address id in the path IS caller-supplied, which is why the service scopes
 * every lookup by owner rather than trusting it.
 */
@ApiTags('account')
@Controller()
export class AccountController {
  constructor(private readonly accounts: AccountService) {}

  @Authenticated()
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: "The caller's own profile" })
  @ApiOkResponse({ description: 'The profile. Never any password material.' })
  @ApiUnauthorizedResponse({ description: 'Missing, malformed or expired access token.' })
  getProfile(@Req() request: RequestWithAuth): Promise<Profile> {
    return this.accounts.getProfile(claimsOf(request).sub);
  }

  @Authenticated()
  @Patch('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update the caller's own name" })
  @ApiOkResponse({ description: 'The updated profile.' })
  @ApiUnauthorizedResponse({ description: 'Missing, malformed or expired access token.' })
  updateProfile(
    @Req() request: RequestWithAuth,
    @Body(new ZodValidationPipe(updateProfileRequestSchema)) body: UpdateProfileRequest,
  ): Promise<Profile> {
    return this.accounts.updateProfile(claimsOf(request).sub, body);
  }

  @Authenticated()
  @Get('me/addresses')
  @ApiBearerAuth()
  @ApiOperation({ summary: "List the caller's addresses" })
  @ApiOkResponse({ description: 'Defaults first, then newest.' })
  listAddresses(@Req() request: RequestWithAuth): Promise<Address[]> {
    return this.accounts.listAddresses(claimsOf(request).sub);
  }

  @Authenticated()
  @Post('me/addresses')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Add an address' })
  @ApiCreatedResponse({ description: 'The created address.' })
  createAddress(
    @Req() request: RequestWithAuth,
    @Body(new ZodValidationPipe(createAddressRequestSchema)) body: CreateAddressRequest,
  ): Promise<Address> {
    return this.accounts.createAddress(claimsOf(request).sub, body);
  }

  @Authenticated()
  @Get('me/addresses/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One of the caller’s addresses' })
  @ApiOkResponse({ description: 'The address.' })
  @ApiNotFoundResponse({
    description: "No such address for this caller — including another account's address.",
  })
  getAddress(
    @Req() request: RequestWithAuth,
    @Param('id', new ZodValidationPipe(addressIdSchema)) id: string,
  ): Promise<Address> {
    return this.accounts.getAddress(id, claimsOf(request).sub);
  }

  @Authenticated()
  @Patch('me/addresses/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update one of the caller’s addresses' })
  @ApiOkResponse({ description: 'The updated address.' })
  @ApiNotFoundResponse({
    description: "No such address for this caller — including another account's address.",
  })
  updateAddress(
    @Req() request: RequestWithAuth,
    @Param('id', new ZodValidationPipe(addressIdSchema)) id: string,
    @Body(new ZodValidationPipe(updateAddressRequestSchema)) body: UpdateAddressRequest,
  ): Promise<Address> {
    return this.accounts.updateAddress(id, claimsOf(request).sub, body);
  }

  @Authenticated()
  @Delete('me/addresses/:id')
  @HttpCode(204)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Remove one of the caller’s addresses' })
  @ApiNoContentResponse({ description: 'Removed.' })
  @ApiNotFoundResponse({
    description: "No such address for this caller — including another account's address.",
  })
  async deleteAddress(
    @Req() request: RequestWithAuth,
    @Param('id', new ZodValidationPipe(addressIdSchema)) id: string,
  ): Promise<void> {
    await this.accounts.deleteAddress(id, claimsOf(request).sub);
  }
}

/**
 * The verified claims, or a loud failure.
 *
 * `auth` is optional on the type because it describes a request both before and after
 * the guard. On an `@Authenticated()` route the guard has already run, so absence means
 * the guard was unregistered — a wiring bug, not a client error. Throwing gives a 500
 * naming the cause instead of a TypeError deep in a handler.
 */
function claimsOf(request: RequestWithAuth): AccessTokenClaims {
  if (!request.auth) {
    throw new Error('Route is marked @Authenticated but no claims were attached by the guard');
  }
  return request.auth;
}
