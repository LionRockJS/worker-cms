import type { FeatureServiceEntry } from '../services';
import { mutatePageLifecycle, trashPagesAsService } from './lifecycle-mutation-evidence';

export const trashServices: FeatureServiceEntry = {
  id: 'trash',
  trashLifecycle: { mutatePageLifecycle, trashPagesAsService },
};
