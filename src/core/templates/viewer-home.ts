import { adminLayout, type BaseTemplateProps } from '../render/layout';
import { renderView } from '../render/liquid';

export async function viewerHomePage(views: Fetcher, opts: BaseTemplateProps): Promise<string> {
  const body = await renderView(views, '/templates/viewer-home.json', {});
  return adminLayout(views, opts, { title: 'Dashboard', body });
}
