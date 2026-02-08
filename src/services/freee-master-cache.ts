/**
 * freee Master Data Cache Service
 *
 * Caches freee master data (account items, taxes, partners) in Cloudflare KV.
 * Uses conservative TTLs to respect API rate limits.
 */

import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';

// =============================================================================
// Types
// =============================================================================

export interface FreeeAccountItem {
  id: number;
  name: string;
  [key: string]: unknown;
}

export interface FreeeTax {
  id: number;
  name: string;
  rate?: number;
  [key: string]: unknown;
}

export interface FreeePartner {
  id: number;
  name: string;
  shortcut1?: string;
  shortcut2?: string;
  [key: string]: unknown;
}

export interface FreeeMasterCacheState {
  accountItems: FreeeAccountItem[];
  taxes: FreeeTax[];
  partners: FreeePartner[];
}

interface FreeeAccountItemsResponse {
  account_items: FreeeAccountItem[];
}

interface FreeeTaxesResponse {
  taxes: FreeeTax[];
}

interface FreeePartnersResponse {
  partners: FreeePartner[];
}

interface FreeePartnerResponse {
  partner: FreeePartner;
}

type FreeeMasterCacheEnv = Env & {
  FREEE_COMPANY_ID?: string;
  FREEE_BASE_URL?: string;
  // Backward compatibility: some older configs referenced ORCHESTRATOR_KV.
  ORCHESTRATOR_KV?: KVNamespace;
};

type FreeeCacheLabel = 'account_items' | 'taxes' | 'partners';

type FetchOptions = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>;
};

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_BASE_URL = 'https://api.freee.co.jp/api/1';
const ACCOUNT_ITEMS_TTL_SECONDS = 24 * 60 * 60;
const TAXES_TTL_SECONDS = 24 * 60 * 60;
const PARTNERS_TTL_SECONDS = 60 * 60;

const CACHE_KEYS = {
  accountItems: (companyId: string): string => `freee:account_items:${companyId}`,
  taxes: (companyId: string): string => `freee:taxes:${companyId}`,
  partners: (companyId: string): string => `freee:partners:${companyId}`,
};

// =============================================================================
// Helpers
// =============================================================================

function getBaseUrl(env: FreeeMasterCacheEnv): string {
  return env.FREEE_BASE_URL ?? DEFAULT_BASE_URL;
}

function getCompanyId(env: FreeeMasterCacheEnv): string {
  const companyId = env.FREEE_COMPANY_ID;
  if (!companyId) {
    throw new Error('FREEE_COMPANY_ID is required');
  }
  return companyId;
}

function getKv(env: FreeeMasterCacheEnv): KVNamespace | null {
  // Prefer the canonical KV binding used in this repo.
  // Fallback to CACHE (older deployments) and ORCHESTRATOR_KV (legacy name).
  const kv = env.KV ?? env.CACHE ?? env.ORCHESTRATOR_KV ?? null;
  if (!kv) {
    safeLog(env, 'warn', '[FreeeMasterCache] KV not configured (cache disabled)', {});
    return null;
  }
  return kv;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown error';
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function cloneList<T extends Record<string, unknown>>(items: T[]): T[] {
  return items.map((item) => ({ ...item }));
}

function mergePartners(
  existing: FreeePartner[],
  incoming: FreeePartner[]
): FreeePartner[] {
  const merged = new Map<number, FreeePartner>();
  for (const partner of existing) {
    merged.set(partner.id, { ...partner });
  }
  for (const partner of incoming) {
    merged.set(partner.id, { ...partner });
  }
  return Array.from(merged.values());
}

async function readCache<T>(
  env: FreeeMasterCacheEnv,
  key: string,
  label: FreeeCacheLabel
): Promise<T | null> {
  const kv = getKv(env);
  if (!kv) {
    return null;
  }

  try {
    const cached = await kv.get<T>(key, 'json');
    if (cached !== null) {
      safeLog(env, 'info', '[FreeeMasterCache] cache hit', { label });
      return cached;
    }
    safeLog(env, 'info', '[FreeeMasterCache] cache miss', { label });
    return null;
  } catch (error) {
    safeLog(env, 'warn', '[FreeeMasterCache] cache read failed', {
      label,
      error: toErrorMessage(error),
    });
    return null;
  }
}

async function writeCache<T>(
  env: FreeeMasterCacheEnv,
  key: string,
  value: T,
  ttlSeconds: number,
  label: FreeeCacheLabel
): Promise<void> {
  const kv = getKv(env);
  if (!kv) {
    return;
  }

  try {
    await kv.put(key, JSON.stringify(value), {
      expirationTtl: ttlSeconds,
    });
    safeLog(env, 'info', '[FreeeMasterCache] cache updated', {
      label,
      ttlSeconds,
    });
  } catch (error) {
    safeLog(env, 'warn', '[FreeeMasterCache] cache write failed', {
      label,
      error: toErrorMessage(error),
    });
  }
}

async function deleteCache(
  env: FreeeMasterCacheEnv,
  key: string,
  label: FreeeCacheLabel
): Promise<void> {
  const kv = getKv(env);
  if (!kv) {
    return;
  }

  try {
    await kv.delete(key);
    safeLog(env, 'info', '[FreeeMasterCache] cache invalidated', { label });
  } catch (error) {
    safeLog(env, 'warn', '[FreeeMasterCache] cache invalidation failed', {
      label,
      error: toErrorMessage(error),
    });
  }
}

async function fetchFreee<T>(
  env: FreeeMasterCacheEnv,
  accessToken: string,
  path: string,
  options: FetchOptions = {}
): Promise<T> {
  const baseUrl = getBaseUrl(env);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    ...options.headers,
  };

  const requestInit: RequestInit = {
    ...options,
    headers: { ...headers },
  };

  const response = await fetch(`${baseUrl}${path}`, requestInit);

  if (!response.ok) {
    const details = await response.text();
    safeLog(env, 'error', '[FreeeMasterCache] freee API error', {
      status: response.status,
      statusText: response.statusText,
      path,
    });
    throw new Error(
      `freee API error ${response.status}: ${response.statusText}${details ? ` - ${details}` : ''}`
    );
  }

  return response.json() as Promise<T>;
}

async function fetchAccountItemsFromApi(
  env: FreeeMasterCacheEnv,
  accessToken: string
): Promise<FreeeAccountItem[]> {
  const companyId = getCompanyId(env);
  const params = new URLSearchParams({ company_id: companyId });
  const response = await fetchFreee<FreeeAccountItemsResponse>(
    env,
    accessToken,
    `/account_items?${params.toString()}`
  );
  return cloneList(response.account_items);
}

async function fetchTaxesFromApi(
  env: FreeeMasterCacheEnv,
  accessToken: string
): Promise<FreeeTax[]> {
  const companyId = getCompanyId(env);
  const params = new URLSearchParams({ company_id: companyId });
  const response = await fetchFreee<FreeeTaxesResponse>(
    env,
    accessToken,
    `/taxes?${params.toString()}`
  );
  return cloneList(response.taxes);
}

async function fetchPartnersFromApi(
  env: FreeeMasterCacheEnv,
  accessToken: string,
  keyword?: string
): Promise<FreeePartner[]> {
  const companyId = getCompanyId(env);
  const params = new URLSearchParams({ company_id: companyId });
  if (keyword) {
    params.append('keyword', keyword);
  }
  const response = await fetchFreee<FreeePartnersResponse>(
    env,
    accessToken,
    `/partners?${params.toString()}`
  );
  return cloneList(response.partners);
}

function findPartnerInList(
  partners: FreeePartner[],
  name: string
): FreeePartner | null {
  const normalized = normalizeName(name);
  const match = partners.find(
    (partner) => normalizeName(partner.name) === normalized
  );
  return match ? { ...match } : null;
}

// =============================================================================
// Public API
// =============================================================================

export async function getAccountItems(
  env: FreeeMasterCacheEnv,
  accessToken: string
): Promise<FreeeAccountItem[]> {
  const companyId = getCompanyId(env);
  const key = CACHE_KEYS.accountItems(companyId);
  const cached = await readCache<FreeeAccountItem[]>(env, key, 'account_items');

  if (cached !== null) {
    return cloneList(cached);
  }

  const items = await fetchAccountItemsFromApi(env, accessToken);
  await writeCache(env, key, items, ACCOUNT_ITEMS_TTL_SECONDS, 'account_items');
  return cloneList(items);
}

export async function getTaxes(
  env: FreeeMasterCacheEnv,
  accessToken: string
): Promise<FreeeTax[]> {
  const companyId = getCompanyId(env);
  const key = CACHE_KEYS.taxes(companyId);
  const cached = await readCache<FreeeTax[]>(env, key, 'taxes');

  if (cached !== null) {
    return cloneList(cached);
  }

  const taxes = await fetchTaxesFromApi(env, accessToken);
  await writeCache(env, key, taxes, TAXES_TTL_SECONDS, 'taxes');
  return cloneList(taxes);
}

export async function findPartnerByName(
  env: FreeeMasterCacheEnv,
  accessToken: string,
  name: string
): Promise<FreeePartner | null> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('Partner name is required');
  }

  const companyId = getCompanyId(env);
  const key = CACHE_KEYS.partners(companyId);
  const cached = await readCache<FreeePartner[]>(env, key, 'partners');

  if (cached !== null) {
    const cachedMatch = findPartnerInList(cached, trimmedName);
    if (cachedMatch) {
      return cachedMatch;
    }
    safeLog(env, 'info', '[FreeeMasterCache] partner cache miss', {
      label: 'partners',
    });
  }

  const fetched = await fetchPartnersFromApi(env, accessToken, trimmedName);
  if (fetched.length === 0) {
    return null;
  }

  const merged = mergePartners(cached ?? [], fetched);
  await writeCache(env, key, merged, PARTNERS_TTL_SECONDS, 'partners');
  return findPartnerInList(merged, trimmedName);
}

export async function createPartner(
  env: FreeeMasterCacheEnv,
  accessToken: string,
  name: string
): Promise<FreeePartner> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('Partner name is required');
  }

  const companyId = getCompanyId(env);
  const payload = {
    company_id: companyId,
    name: trimmedName,
  };

  const response = await fetchFreee<FreeePartnerResponse>(
    env,
    accessToken,
    '/partners',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...payload }),
    }
  );

  const key = CACHE_KEYS.partners(companyId);
  await deleteCache(env, key, 'partners');
  return { ...response.partner };
}

export async function refreshCache(
  env: FreeeMasterCacheEnv,
  accessToken: string
): Promise<FreeeMasterCacheState> {
  const companyId = getCompanyId(env);

  // Fetch all master data in parallel (3 API calls)
  const [accountItems, taxes, partners] = await Promise.all([
    fetchAccountItemsFromApi(env, accessToken),
    fetchTaxesFromApi(env, accessToken),
    fetchPartnersFromApi(env, accessToken),
  ]);

  // Write all caches in parallel
  await Promise.all([
    writeCache(env, CACHE_KEYS.accountItems(companyId), accountItems, ACCOUNT_ITEMS_TTL_SECONDS, 'account_items'),
    writeCache(env, CACHE_KEYS.taxes(companyId), taxes, TAXES_TTL_SECONDS, 'taxes'),
    writeCache(env, CACHE_KEYS.partners(companyId), partners, PARTNERS_TTL_SECONDS, 'partners'),
  ]);

  return {
    accountItems: [...accountItems],
    taxes: [...taxes],
    partners: [...partners],
  };
}
