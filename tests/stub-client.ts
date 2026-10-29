import type { RxLocalClient } from '../src/client.js';

export function stubClient(overrides: Partial<Record<keyof RxLocalClient, unknown>> = {}): RxLocalClient {
  const base = {
    getUserInfo: async () => ({
      globalUserID: 'U-1', userName: 'jane', firstName: 'Jane', lastName: 'Doe',
      emailAddress: 'jane@example.com', smsPhone: '555-0100', accountType: 0,
      rxLocalPatientID: 'P-1', primaryPersonID: 'PP-1', roles: ['patient'],
      entityStatus: 'Active', passwordExpired: false, termsAcceptanceRequired: false,
    }),
    getAge: async () => ({ underMinimumAge: false, minimumAge: 18 }),
    getNotifications: async (_id: string) => ({ messageType: 1 }),
    getLegal: async (_k: string) => ({ id: 1, content: '<p>x</p>', userAcceptanceRequired: false }),
    credentialStatus: async () => ({ source: 'fetchproxy' as const, expiresAt: new Date('2030-01-01') }),
  };
  return { ...base, ...overrides } as unknown as RxLocalClient;
}
