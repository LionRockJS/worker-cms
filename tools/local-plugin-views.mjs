// Shared by the Miniflare launcher and standalone workerd config generator.
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

export function localPluginViewsOptions(environment = process.env) {
  const directory = environment.PLUGIN_VIEWS_DIR?.trim();
  if (!directory) {
    if (environment.PLUGIN_VIEWS_NGINX === 'true') throw new Error('PLUGIN_VIEWS_NGINX requires PLUGIN_VIEWS_DIR.');
    return {};
  }
  const path = resolve(directory);
  if (!statSync(path).isDirectory()) throw new Error('PLUGIN_VIEWS_DIR must be a directory.');
  return {
    serviceBindings: { PLUGIN_LOCAL_VIEWS: { disk: { path, writable: false } } },
    bindings: { PLUGIN_VIEWS_NGINX: environment.PLUGIN_VIEWS_NGINX === 'true' ? 'true' : 'false' },
  };
}
