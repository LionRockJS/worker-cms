// Page administration, split by concern and mounted in the original
// registration order.

import { Hono } from 'hono';
import type { Env, Variables } from '../../../types';
import { pageDashboardRoutes } from './dashboard';
import { pageAccessRoutes } from './access';
import { pageCrudRoutes } from './crud';
import { pageLifecycleRoutes } from './lifecycle';

export const pagesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

pagesRoutes.route('/', pageDashboardRoutes);
pagesRoutes.route('/', pageCrudRoutes);
pagesRoutes.route('/', pageLifecycleRoutes);

pagesRoutes.route('/', pageAccessRoutes);
