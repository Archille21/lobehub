import type { ClientDataEntityRecord, ClientDataIndex, ClientDataSnapshot } from '@lobechat/types';

import { isClientDataEntityRecord } from './entities/validators';
import { isChatIndex } from './modules/chat/validators';
import { isHomeIndex, isHomeSnapshot } from './modules/home/validators';
import { createClientDataRepository } from './persistence/repository';

export const clientDataRepository = createClientDataRepository<
  ClientDataEntityRecord,
  ClientDataIndex,
  ClientDataSnapshot
>({
  isEntity: isClientDataEntityRecord,
  isIndex: (value): value is ClientDataIndex => isHomeIndex(value) || isChatIndex(value),
  isSnapshot: isHomeSnapshot,
});
