import { z } from 'zod';
import { ErrorCodes, TestLeaseError } from '@testlease/protocol';

export const LIMITS = {
  maxOwnerLength: 200,
  maxIdLength: 128,
  maxTagCount: 32,
  maxTagKeyLength: 64,
  maxTagValueLength: 256,
  maxMetadataEntries: 32,
  maxMetadataValueLength: 1000,
  maxPurposeLength: 500,
  maxReasonLength: 1000,
  minTtlMs: 1_000,
  maxTtlMs: 7 * 86_400_000,
  maxWaitTimeoutMs: 24 * 3_600_000,
} as const;

const idString = z.string().min(1).max(LIMITS.maxIdLength);

export const ownerSchema = z
  .string()
  .min(1, 'owner must not be empty')
  .max(LIMITS.maxOwnerLength)
  .regex(/^\S+$/, 'owner must not contain whitespace')
  .refine((s) => !/\p{Cc}/u.test(s), 'owner must not contain control characters');

export const tagsSchema = z
  .record(z.string().min(1).max(LIMITS.maxTagKeyLength), z.string().max(LIMITS.maxTagValueLength))
  .refine((t) => Object.keys(t).length <= LIMITS.maxTagCount, {
    message: `at most ${LIMITS.maxTagCount} tags`,
  });

export const stringMetadataSchema = z
  .record(
    z.string().min(1).max(LIMITS.maxTagKeyLength),
    z.string().max(LIMITS.maxMetadataValueLength),
  )
  .refine((m) => Object.keys(m).length <= LIMITS.maxMetadataEntries, {
    message: `at most ${LIMITS.maxMetadataEntries} metadata entries`,
  });

export const ttlSchema = z.number().int().min(LIMITS.minTtlMs).max(LIMITS.maxTtlMs);

export const acquireRequestSchema = z.strictObject({
  pool: idString,
  owner: ownerSchema,
  tags: tagsSchema.optional(),
  ttlMs: ttlSchema.optional(),
  waitTimeoutMs: z.number().int().min(0).max(LIMITS.maxWaitTimeoutMs).optional(),
  clientRequestId: z.string().min(1).max(LIMITS.maxOwnerLength).optional(),
  purpose: z.string().max(LIMITS.maxPurposeLength).optional(),
  context: stringMetadataSchema.optional(),
});

/** Authenticated identity (token name or `local`). Same shape rules as `owner`. */
export const principalSchema = ownerSchema;

export const renewRequestSchema = z.strictObject({
  owner: ownerSchema,
  ttlMs: ttlSchema.optional(),
});

export const releaseRequestSchema = z.strictObject({
  owner: ownerSchema,
  force: z.boolean().optional(),
});

export const quarantineRequestSchema = z.strictObject({
  owner: ownerSchema,
  reason: z.string().min(1, 'a quarantine reason is required').max(LIMITS.maxReasonLength),
  force: z.boolean().optional(),
});

export const quarantineResourceRequestSchema = z.strictObject({
  reason: z.string().min(1, 'a quarantine reason is required').max(LIMITS.maxReasonLength),
  force: z.boolean().optional(),
});

export const resolveSecretsRequestSchema = z.strictObject({
  owner: ownerSchema,
});

export const idSchema = idString.regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  'identifiers may contain letters, digits, ".", "_", ":" and "-"',
);

/** Validates input against a schema and converts failures into INVALID_REQUEST errors. */
export function validate<T extends z.ZodType>(
  schema: T,
  input: unknown,
  what: string,
): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => ({
    path: i.path.map(String).join('.'),
    message: i.message,
  }));
  const summary = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
  throw new TestLeaseError(ErrorCodes.INVALID_REQUEST, `Invalid ${what}: ${summary}`, { issues });
}
