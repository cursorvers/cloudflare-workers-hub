import { SUBJECT_TYPES } from '../types';

export type AutopilotSubjectType = (typeof SUBJECT_TYPES)[keyof typeof SUBJECT_TYPES];

export interface AuthResult {
  readonly authenticated: boolean;
  readonly subject: { readonly id: string; readonly type: AutopilotSubjectType } | null;
  readonly role: 'admin' | 'operator' | 'viewer' | null;
  readonly reason: string;
}

export interface WebhookVerification {
  readonly valid: boolean;
  readonly reason: string;
}

export interface CSRFCheck {
  readonly valid: boolean;
  readonly reason: string;
}

export interface OverridePermission {
  readonly allowed: boolean;
  readonly reason: string;
}
