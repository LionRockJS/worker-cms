import type { D1Migration } from 'cloudflare:test';
import type { Env as AppEnv } from '../src/types';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
      TEST_PUBLISHED_MIGRATIONS: D1Migration[];
      /** Raw text of the committed migrations/0001_initial_schema.sql. */
      TEST_COMMITTED_BASELINE: string;
      /** Freshly assembled baseline for the profile in cms.features.json. */
      TEST_ASSEMBLED_BASELINE: string;
      /** Freshly assembled baseline with every optional feature disabled. */
      TEST_ASSEMBLED_LEAN_BASELINE: string;
      /** Comma-separated ids of every fragment under schema/cms/features. */
      TEST_AVAILABLE_FEATURES: string;
      /** Comma-separated ids of every feature shipping a views/ directory. */
      TEST_AVAILABLE_VIEW_FEATURES: string;
      /** Comma-separated dist/views paths for the profile in cms.features.json. */
      TEST_ASSEMBLED_VIEW_PATHS: string;
      /** Comma-separated dist/views paths with every optional feature disabled. */
      TEST_ASSEMBLED_LEAN_VIEW_PATHS: string;
      /** Assembled locales/en.json for the profile in cms.features.json. */
      TEST_ASSEMBLED_VIEW_LOCALE: string;
      /** Assembled locales/en.json with every optional feature disabled. */
      TEST_ASSEMBLED_LEAN_VIEW_LOCALE: string;
    }

  }
}

declare module 'cloudflare:workers' {
  interface ProvidedEnv extends AppEnv {
    TEST_MIGRATIONS: D1Migration[];
    TEST_PUBLISHED_MIGRATIONS: D1Migration[];
  }
}
