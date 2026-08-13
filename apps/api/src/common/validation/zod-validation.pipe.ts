import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodType } from 'zod';
import { ValidationError } from '../errors/domain-error';
import { zodToFieldErrors } from '../filters/problem-details.filter';

/**
 * Parses a payload with a schema from `@repo/contracts` (I2).
 *
 * Converts a ZodError into a `ValidationError` — the explicit "the caller sent
 * something wrong" signal. That conversion is what makes it a 422 with per-field
 * `errors[]`; a bare ZodError reaching the filter is treated as an internal fault
 * instead, because it could equally have come from parsing an upstream provider's
 * response, and mapping that to 422 would blame the caller and publish internal field
 * paths (found by pr-reviewer).
 *
 * Usage: `@Body(new ZodValidationPipe(createOrderSchema)) body: CreateOrder`
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(
          'The request did not match the expected shape.',
          zodToFieldErrors(error),
        );
      }
      throw error;
    }
  }
}
