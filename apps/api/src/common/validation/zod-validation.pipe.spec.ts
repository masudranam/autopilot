import { z } from 'zod';
import { type ArgumentMetadata } from '@nestjs/common';
import { ZodValidationPipe } from './zod-validation.pipe';
import { ValidationError } from '../errors/domain-error';

const metadata = { type: 'body' } as ArgumentMetadata;

const schema = z.object({
  email: z.email(),
  quantity: z.int().positive(),
  nested: z.object({ sku: z.string().min(1) }).optional(),
});

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(schema);

  it('returns the parsed value on success', () => {
    expect(pipe.transform({ email: 'a@b.co', quantity: 2 }, metadata)).toEqual({
      email: 'a@b.co',
      quantity: 2,
    });
  });

  it('strips unknown keys rather than passing them through', () => {
    const result = pipe.transform({ email: 'a@b.co', quantity: 1, isAdmin: true }, metadata);
    expect(result).not.toHaveProperty('isAdmin');
  });

  // The conversion is the point: a bare ZodError reaching the filter is treated as an
  // internal fault, so request validation must raise the explicit caller-fault signal.
  it('converts a ZodError into a ValidationError carrying field errors', () => {
    expect.assertions(4);
    try {
      pipe.transform({ email: 'nope', quantity: -1 }, metadata);
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validation = error as ValidationError;
      expect(validation.status).toBe(422);
      expect(validation.errors?.map((fieldError) => fieldError.path).sort()).toEqual([
        'email',
        'quantity',
      ]);
      expect(validation.errors?.every((fieldError) => fieldError.message.length > 0)).toBe(true);
    }
  });

  it('reports nested paths in dotted notation', () => {
    try {
      pipe.transform({ email: 'a@b.co', quantity: 1, nested: { sku: '' } }, metadata);
    } catch (error) {
      expect((error as ValidationError).errors?.[0]?.path).toBe('nested.sku');
    }
    expect.hasAssertions();
  });

  it('rethrows a non-Zod failure untouched', () => {
    const exploding = new ZodValidationPipe({
      parse: () => {
        throw new TypeError('not a zod problem');
      },
    } as unknown as z.ZodType<unknown>);
    expect(() => exploding.transform({}, metadata)).toThrow(TypeError);
  });
});
