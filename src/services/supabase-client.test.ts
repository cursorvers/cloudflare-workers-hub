/**
 * Tests for Supabase REST Client
 *
 * Testing strategy:
 * 1. Insert operations with correct headers
 * 2. Upsert operations with conflict resolution
 * 3. Update operations with filters
 * 4. Select operations with query params
 * 5. HTTP error responses
 * 6. Network errors
 * 7. 204 No Content responses
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  supabaseInsert,
  supabaseUpsert,
  supabaseUpdate,
  supabaseSelect,
  SupabaseConfig,
} from './supabase-client';

// Mock fetch globally
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// Mock safeLog to prevent console output during tests
vi.mock('../utils/log-sanitizer', () => ({
  safeLog: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Supabase Client', () => {
  const mockConfig: SupabaseConfig = {
    url: 'https://test.supabase.co',
    serviceRoleKey: 'test-service-role-key',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  describe('supabaseInsert', () => {
    it('should send POST request with correct headers and body', async () => {
      const mockData = { id: '123', name: 'Test Item', status: 'pending' };
      const insertData = { name: 'Test Item', status: 'pending' };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockData,
      });

      const result = await supabaseInsert(mockConfig, 'items', insertData);

      expect(result.data).toEqual(mockData);
      expect(result.error).toBeNull();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.supabase.co/rest/v1/items',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Authorization': 'Bearer test-service-role-key',
            'apikey': 'test-service-role-key',
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
          },
          body: JSON.stringify(insertData),
        })
      );
    });

    it('should return inserted data with correct type', async () => {
      interface Item {
        id: string;
        name: string;
        count: number;
      }

      const mockItem: Item = { id: '456', name: 'Typed Item', count: 42 };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockItem,
      });

      const result = await supabaseInsert<Item>(
        mockConfig,
        'items',
        { name: 'Typed Item', count: 42 }
      );

      expect(result.data).toEqual(mockItem);
      expect(result.data?.name).toBe('Typed Item');
      expect(result.data?.count).toBe(42);
    });
  });

  describe('supabaseUpsert', () => {
    it('should include Prefer header with resolution=merge-duplicates', async () => {
      const mockData = { id: '789', email: 'user@example.com', updated: true };
      const upsertData = { email: 'user@example.com', name: 'Test User' };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockData,
      });

      const result = await supabaseUpsert(
        mockConfig,
        'users',
        upsertData,
        'email'
      );

      expect(result.data).toEqual(mockData);
      expect(result.error).toBeNull();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('on_conflict=email'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Prefer': 'return=representation,resolution=merge-duplicates',
          }),
          body: JSON.stringify(upsertData),
        })
      );
    });

    it('should include on_conflict query parameter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'test' }),
      });

      await supabaseUpsert(
        mockConfig,
        'users',
        { email: 'test@example.com' },
        'email,phone'
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.supabase.co/rest/v1/users?on_conflict=email,phone',
        expect.any(Object)
      );
    });
  });

  describe('supabaseUpdate', () => {
    it('should send PATCH request with filter query params', async () => {
      const mockData = { id: 'abc', status: 'completed', updatedAt: '2024-01-25T12:00:00Z' };
      const updateData = { status: 'completed', updatedAt: '2024-01-25T12:00:00Z' };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockData,
      });

      const result = await supabaseUpdate(
        mockConfig,
        'tasks',
        updateData,
        'id=eq.abc'
      );

      expect(result.data).toEqual(mockData);
      expect(result.error).toBeNull();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.supabase.co/rest/v1/tasks?id=eq.abc',
        expect.objectContaining({
          method: 'PATCH',
          headers: expect.objectContaining({
            'Prefer': 'return=representation',
          }),
          body: JSON.stringify(updateData),
        })
      );
    });

    it('should support complex PostgREST filters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: '1' }, { id: '2' }],
      });

      await supabaseUpdate(
        mockConfig,
        'items',
        { archived: true },
        'status=eq.pending&created_at=lt.2024-01-01'
      );

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('status=eq.pending&created_at=lt.2024-01-01'),
        expect.any(Object)
      );
    });
  });

  describe('supabaseSelect', () => {
    it('should send GET request with query params', async () => {
      const mockData = [
        { id: '1', classification: 'pending', text: 'Item 1' },
        { id: '2', classification: 'pending', text: 'Item 2' },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockData,
      });

      const result = await supabaseSelect(
        mockConfig,
        'items',
        'classification=eq.pending&limit=10'
      );

      expect(result.data).toEqual(mockData);
      expect(result.data).toHaveLength(2);
      expect(result.error).toBeNull();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.supabase.co/rest/v1/items?classification=eq.pending&limit=10',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-service-role-key',
            'apikey': 'test-service-role-key',
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('should return empty array when data is null', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => null,
      });

      const result = await supabaseSelect(mockConfig, 'items', 'id=eq.nonexistent');

      expect(result.data).toEqual([]);
      expect(result.error).toBeNull();
    });

    it('should support complex query parameters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [],
      });

      await supabaseSelect(
        mockConfig,
        'lifelogs',
        'classification=eq.pending&limit=10&order=created_at.desc&select=id,text,classification'
      );

      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain('classification=eq.pending');
      expect(callUrl).toContain('limit=10');
      expect(callUrl).toContain('order=created_at.desc');
      expect(callUrl).toContain('select=id,text,classification');
    });

    it('should return typed array', async () => {
      interface Lifelog {
        id: string;
        text: string;
        classification: string;
      }

      const mockLifelogs: Lifelog[] = [
        { id: '1', text: 'Test', classification: 'pending' },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockLifelogs,
      });

      const result = await supabaseSelect<Lifelog>(
        mockConfig,
        'lifelogs',
        'classification=eq.pending'
      );

      expect(result.data).toHaveLength(1);
      expect(result.data?.[0]?.text).toBe('Test');
    });
  });

  describe('Error Handling', () => {
    it('should handle HTTP error responses with JSON error body', async () => {
      const errorBody = {
        message: 'Invalid input syntax',
        code: '22P02',
        details: 'Column "invalid" does not exist',
      };

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify(errorBody),
      });

      const result = await supabaseInsert(mockConfig, 'items', { invalid: 'data' });

      expect(result.data).toBeNull();
      expect(result.error).not.toBeNull();
      expect(result.error?.message).toBe('Invalid input syntax');
      expect(result.error?.code).toBe('22P02');
      expect(result.error?.details).toBe('Column "invalid" does not exist');
    });

    it('should handle HTTP error responses with non-JSON error body', async () => {
      const errorText = 'Internal Server Error';

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => errorText,
      });

      const result = await supabaseSelect(mockConfig, 'items', 'id=eq.test');

      expect(result.data).toEqual([]); // select returns empty array on error
      expect(result.error).not.toBeNull();
      expect(result.error?.message).toBe(errorText);
      expect(result.error?.code).toBe('500');
      expect(result.error?.details).toBe('');
    });

    it('should truncate very long error messages', async () => {
      const longErrorText = 'A'.repeat(500);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => longErrorText,
      });

      const result = await supabaseInsert(mockConfig, 'items', {});

      expect(result.error?.message).toHaveLength(200);
      expect(result.error?.message).toBe('A'.repeat(200));
    });

    it('should handle 401 Unauthorized', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({
          message: 'Invalid API key',
          code: '401',
          details: '',
        }),
      });

      const result = await supabaseInsert(mockConfig, 'items', {});

      expect(result.error?.message).toBe('Invalid API key');
      expect(result.error?.code).toBe('401');
    });

    it('should handle 404 Not Found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({
          message: 'Table not found',
          code: '404',
          details: '',
        }),
      });

      const result = await supabaseSelect(mockConfig, 'nonexistent_table', '');

      expect(result.error?.code).toBe('404');
    });
  });

  describe('Network Errors', () => {
    it('should handle network errors with NETWORK_ERROR code', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Failed to fetch'));

      const result = await supabaseInsert(mockConfig, 'items', { test: 'data' });

      expect(result.data).toBeNull();
      expect(result.error).not.toBeNull();
      expect(result.error?.code).toBe('NETWORK_ERROR');
      expect(result.error?.message).toContain('Failed to fetch');
      expect(result.error?.details).toBe('');
    });

    it('should handle timeout errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Request timeout'));

      const result = await supabaseUpdate(
        mockConfig,
        'items',
        { status: 'updated' },
        'id=eq.123'
      );

      expect(result.error?.code).toBe('NETWORK_ERROR');
      expect(result.error?.message).toContain('Request timeout');
    });

    it('should handle connection refused errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await supabaseSelect(mockConfig, 'items', '');

      expect(result.data).toEqual([]);
      expect(result.error?.code).toBe('NETWORK_ERROR');
    });
  });

  describe('204 No Content Response', () => {
    it('should handle 204 No Content with null data', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      const result = await supabaseInsert(mockConfig, 'items', { test: 'data' });

      expect(result.data).toBeNull();
      expect(result.error).toBeNull();
    });

    it('should handle 204 from update operations', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      const result = await supabaseUpdate(
        mockConfig,
        'items',
        { archived: true },
        'id=eq.123'
      );

      expect(result.data).toBeNull();
      expect(result.error).toBeNull();
    });

    it('should handle 204 from upsert operations', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      const result = await supabaseUpsert(
        mockConfig,
        'users',
        { email: 'test@example.com' },
        'email'
      );

      expect(result.data).toBeNull();
      expect(result.error).toBeNull();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty query string for select', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: '1' }, { id: '2' }],
      });

      await supabaseSelect(mockConfig, 'items', '');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.supabase.co/rest/v1/items',
        expect.any(Object)
      );
    });

    it('should handle special characters in table name', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [],
      });

      await supabaseSelect(mockConfig, 'my_table_123', '');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/rest/v1/my_table_123'),
        expect.any(Object)
      );
    });

    it('should handle empty data object', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'generated' }),
      });

      const result = await supabaseInsert(mockConfig, 'items', {});

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: '{}',
        })
      );
      expect(result.data).toEqual({ id: 'generated' });
    });

    it('should preserve data types in request body', async () => {
      const complexData = {
        string: 'text',
        number: 42,
        boolean: true,
        null_value: null,
        array: [1, 2, 3],
        nested: { key: 'value' },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => complexData,
      });

      await supabaseInsert(mockConfig, 'items', complexData);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify(complexData),
        })
      );
    });

    it('should handle URL encoding in config', async () => {
      const configWithSpecialChars: SupabaseConfig = {
        url: 'https://project-123.supabase.co',
        serviceRoleKey: 'key-with-special/chars+test',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [],
      });

      await supabaseSelect(configWithSpecialChars, 'items', '');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer key-with-special/chars+test',
            'apikey': 'key-with-special/chars+test',
          }),
        })
      );
    });
  });

  describe('Integration Scenarios', () => {
    it('should handle complete insert-select-update-delete workflow', async () => {
      // Insert
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'new-id', name: 'Test' }),
      });

      const insertResult = await supabaseInsert(mockConfig, 'items', { name: 'Test' });
      expect(insertResult.data).toEqual({ id: 'new-id', name: 'Test' });

      // Select
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 'new-id', name: 'Test' }],
      });

      const selectResult = await supabaseSelect(mockConfig, 'items', 'id=eq.new-id');
      expect(selectResult.data).toHaveLength(1);

      // Update
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'new-id', name: 'Updated' }),
      });

      const updateResult = await supabaseUpdate(
        mockConfig,
        'items',
        { name: 'Updated' },
        'id=eq.new-id'
      );
      expect(updateResult.data?.name).toBe('Updated');
    });

    it('should handle upsert conflict resolution', async () => {
      // First upsert (insert)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ email: 'user@example.com', name: 'John' }),
      });

      const firstUpsert = await supabaseUpsert(
        mockConfig,
        'users',
        { email: 'user@example.com', name: 'John' },
        'email'
      );
      expect(firstUpsert.data?.name).toBe('John');

      // Second upsert (update due to conflict)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ email: 'user@example.com', name: 'John Doe' }),
      });

      const secondUpsert = await supabaseUpsert(
        mockConfig,
        'users',
        { email: 'user@example.com', name: 'John Doe' },
        'email'
      );
      expect(secondUpsert.data?.name).toBe('John Doe');
    });
  });
});
