// Core domain types for AI Credit Repair.
// These mirror the on-device SQLite schema (see src/db/schema.ts).

export type Source = 'credit_karma' | 'equifax' | 'experian' | 'transunion';
export type Bureau = 'equifax' | 'experian' | 'transunion';
export type DocumentKind = 'image' | 'pdf';

export type ItemCategory =
  | 'collection'
  | 'charge_off'
  | 'late_payment'
  | 'repossession'
  | 'public_record'
  | 'inquiry';

export type Confidence = 'low' | 'medium' | 'high';

export type RecommendedAction =
  | 'fcra_dispute'
  | 'furnisher_dispute'
  | 'debt_validation'
  | 'pay_for_delete'
  | 'goodwill'
  | 'let_age_off'
  | 'method_of_verification';

export type LetterType =
  | 'fcra_dispute'
  | 'furnisher_dispute'
  | 'debt_validation'
  | 'pay_for_delete'
  | 'goodwill'
  | 'method_of_verification';

// A single negative item as extracted from one source/bureau.
export interface NegativeItem {
  id?: number;
  accountId?: number | null;
  documentId?: number | null;
  source: Source;
  bureau?: Bureau | null;
  creditorName?: string | null;
  originalCreditor?: string | null;
  accountNumberMasked?: string | null;
  accountType?: string | null;
  itemCategory?: ItemCategory | null;
  balance?: number | null;
  highBalanceOrLimit?: number | null;
  dateOpened?: string | null;
  dateFirstDelinquency?: string | null;
  dofdIsEstimated?: boolean;
  dofdDerivation?: string | null;
  estimatedRemovalDate?: string | null;
  chargeOffDate?: string | null;
  dateLastActivity?: string | null;
  status?: string | null;
  paymentHistory?: string[] | null;
  // Per-critical-field confidence, e.g. { balance: 'low', dateFirstDelinquency: 'high' }.
  confidence?: Record<string, Confidence> | null;
  rawNotes?: string | null;
  confirmed?: boolean;
  createdAt?: number;
}

// User profile + app settings stored in the key/value `settings` table.
export interface ProfileSettings {
  fullName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string; // 2-letter code, drives SOL lookup
  zip: string;
  model: ModelId;
}

export type ModelId = 'claude-sonnet-4-6' | 'claude-haiku-4-5';
