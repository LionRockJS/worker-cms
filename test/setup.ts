import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyD1Migrations(env.PUBLISHED_DB, env.TEST_PUBLISHED_MIGRATIONS);
});

// Privileged fixture reset, never an application declassification path.
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM page_sensitivity_floors').run();
  await env.DB.prepare('DELETE FROM data_class_floors').run();
});
