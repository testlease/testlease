import { test, expect } from '../../fixtures.js';

for (let i = 1; i <= 6; i++) {
  test(`test-scoped lease ${i}`, async ({ scratch }) => {
    expect(scratch.scope).toBe('test');
    expect(scratch.owner).toMatch(/\/test-[a-f0-9-]+$/);
    expect(scratch.secrets).toEqual({});
    await new Promise((r) => setTimeout(r, 30));
  });
}
