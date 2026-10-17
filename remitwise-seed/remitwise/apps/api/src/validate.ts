import { z } from 'zod';
import { policy } from './config.js';

export const corridors = policy.corridors as unknown as [string, ...string[]];
export const purposes = policy.purposes as unknown as [string, ...string[]];
export const studyLevels = ['school', 'undergraduate', 'postgraduate', 'language', 'diploma'] as const;
export const beneficiaryTypes = ['institution', 'intermediary', 'student_card', 'third_party'] as const;
export const instructionSources = ['user_typed', 'pasted_or_untrusted'] as const;

export const LoginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(6).max(200),
});

export const CompareSchema = z.object({
  corridor: z.enum(corridors),
  amountUSD: z.coerce.number().positive().max(100000),
});

const instructionFields = {
  purpose: z.enum(purposes).optional(),
  studyLevel: z.enum(studyLevels).optional(),
  coveragePeriodMonths: z.coerce.number().positive().max(120).optional(),
  isFirstRelease: z.coerce.boolean().optional(),
  beneficiaryType: z.enum(beneficiaryTypes).optional(),
  namedInInstitutionDocs: z.coerce.boolean().optional(),
  bankBranchId: z.string().max(64).optional(),
  payerName: z.string().max(200).optional(),
  instructionSource: z.enum(instructionSources).optional(),
  note: z.string().max(2000).optional(),
};

export const ComplianceCheckSchema = z.object({
  corridor: z.enum(corridors),
  amountUSD: z.coerce.number().positive().max(100000),
  ...instructionFields,
}).strict();

export const ProposeSchema = z.object({
  corridor: z.enum(corridors),
  amountUSD: z.coerce.number().positive().max(100000),
  routeProvider: z.string().min(1).max(120).optional(),
  ...instructionFields,
}).strict();

export const ConfirmSchema = z.object({
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/i),
  instructionSource: z.enum(instructionSources).optional(),
  note: z.string().max(2000).optional(),
}).strict();

export const AlertSchema = z.object({
  pair: z.string().min(3).max(40),
  target: z.coerce.number().positive(),
  fallbackDate: z.string().min(4).max(40),
}).strict();

export const FxWindowSchema = z.object({
  pair: z.enum(['USD/BDT', 'BDT per MYR', 'MYR/BDT', 'BDT/MYR', 'BD-MY']).optional(),
  days: z.coerce.number().int().positive().max(365).default(30),
}).strict();

export const CompareSchemaQuery = CompareSchema;

// z.enum needs a non-empty tuple; guard the cast at runtime.
for (const c of policy.corridors) z.enum(corridors).parse(c);
for (const p of policy.purposes) z.enum(purposes).parse(p);

export const validate = <T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> => schema.parse(data);
