/**
 * Test script for JWT authentication
 * Demonstrates JWT token generation and verification
 */

import { generateAccessToken, verifyAccessToken, generateRefreshToken } from '../src/utils/jwt-auth';

// Mock Env object
const mockEnv = {
  ENVIRONMENT: 'development',
  JWT_SECRET: 'test-secret-key-for-dev',
  DB: null as any,
} as any;

async function testJWTAuth() {
  console.log('🔐 Testing JWT Authentication...\n');

  try {
    // Test 1: Generate access token
    console.log('Test 1: Generate Access Token');
    const accessToken = await generateAccessToken('test-user-123', 'admin', mockEnv);
    console.log('✅ Access token generated:', accessToken.substring(0, 50) + '...');

    // Test 2: Verify access token
    console.log('\nTest 2: Verify Access Token');
    const payload = await verifyAccessToken(accessToken, mockEnv);
    if (payload) {
      console.log('✅ Token verified successfully');
      console.log('   User ID:', payload.sub);
      console.log('   Role:', payload.role);
      console.log('   Issuer:', payload.iss);
      console.log('   Audience:', payload.aud);
      console.log('   Expires:', new Date(payload.exp * 1000).toISOString());
    } else {
      console.error('❌ Token verification failed');
    }

    // Test 3: Verify invalid token
    console.log('\nTest 3: Verify Invalid Token');
    const invalidPayload = await verifyAccessToken('invalid.token.here', mockEnv);
    if (!invalidPayload) {
      console.log('✅ Invalid token correctly rejected');
    } else {
      console.error('❌ Invalid token was accepted (security issue!)');
    }

    // Test 4: Role-based access control
    console.log('\nTest 4: RBAC Permission Checks');
    const { hasPermission } = await import('../src/utils/jwt-auth');

    const testCases = [
      { method: 'GET', path: '/api/cockpit/tasks', role: 'viewer' as const, expected: true },
      { method: 'POST', path: '/api/cockpit/tasks', role: 'viewer' as const, expected: false },
      { method: 'POST', path: '/api/cockpit/tasks', role: 'operator' as const, expected: true },
      { method: 'DELETE', path: '/api/cockpit/tasks', role: 'operator' as const, expected: false },
      { method: 'DELETE', path: '/api/cockpit/tasks', role: 'admin' as const, expected: true },
    ];

    for (const testCase of testCases) {
      const allowed = hasPermission(testCase.method, testCase.path, testCase.role);
      const status = allowed === testCase.expected ? '✅' : '❌';
      console.log(
        `   ${status} ${testCase.method} ${testCase.path} [${testCase.role}]: ${allowed ? 'ALLOWED' : 'DENIED'}`
      );
    }

    console.log('\n🎉 All tests completed!');
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Run tests
testJWTAuth();
