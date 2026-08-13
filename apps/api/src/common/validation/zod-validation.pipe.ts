import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Parses a payload with a schema from `@repo/contracts` (I2).
 *
 * A thrown ZodError is caught by the global filter and rendered as 422 with per-field
 * `errors[]` — the pipe deliberately does not format anything itself, so there is one
 * place that owns the wire shape.
 *
 * Usage: `@Body(new ZodValidationPipe(createOrderSchema)) body: CreateOrder`
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    return this.schema.parse(value);
  }
}
