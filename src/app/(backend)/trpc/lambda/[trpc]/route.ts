import { TRPC_ASYNC_MAX_DURATION } from '@lobechat/business-config/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { type NextRequest } from 'next/server';

import { createLambdaContext } from '@/libs/trpc/lambda/context';
import { createTRPCErrorLogger } from '@/libs/trpc/utils/errorLogger';
import { prepareRequestForTRPC } from '@/libs/trpc/utils/request-adapter';
import { createResponseMeta } from '@/libs/trpc/utils/responseMeta';
import { lambdaRouter } from '@/server/routers/lambda';

// Some lambda mutations (e.g. video.createVideo) schedule a Next.js `after()`
// background job — most notably the video-generation poll loop, which can
// legitimately run for several minutes. Without this, the function is killed
// under the platform's default duration well before that finishes.
export const maxDuration = TRPC_ASYNC_MAX_DURATION;

const handler = (req: NextRequest) => {
  // Clone the request to avoid "Response body object should not be disturbed or locked" error
  // in Next.js 16 when the body stream has been consumed by Next.js internal mechanisms
  const preparedReq = prepareRequestForTRPC(req);

  return fetchRequestHandler({
    /**
     * @link https://trpc.io/docs/v11/context
     */
    createContext: () => createLambdaContext(req),

    endpoint: '/trpc/lambda',

    onError: createTRPCErrorLogger('lambda'),

    req: preparedReq,
    responseMeta: createResponseMeta,
    router: lambdaRouter,
  });
};

export { handler as GET, handler as POST };
