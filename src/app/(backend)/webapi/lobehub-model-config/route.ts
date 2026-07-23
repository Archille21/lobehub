import { loadLobeHubPlanCardModels, loadModels } from '@lobechat/business-model-bank/model-config';
import { ModelProvider } from 'model-bank';
import { NextResponse } from 'next/server';

/**
 * Public model config for the LobeHub (branded) provider, consumed by the
 * business-model-bank browser loader (`LobeHubPath.webapi.modelConfig`).
 *
 * The payload comes entirely from the `@lobechat/business-model-bank` slot:
 * with the OSS default implementation the LobeHub provider list is empty and
 * this returns an empty config; business overrides that serve a real model
 * directory light it up without any route changes.
 */
export const GET = async () => {
  try {
    const [models, planCardModels] = await Promise.all([
      loadModels(),
      loadLobeHubPlanCardModels().catch(() => [] as string[]),
    ]);

    const clientModels = models.filter(
      (model) =>
        model.providerId === ModelProvider.LobeHub &&
        model.enabled !== false &&
        (model as { visible?: boolean }).visible !== false,
    );

    return NextResponse.json({
      models: clientModels,
      planCardModels,
      version: 1,
    });
  } catch (error) {
    console.error('[lobehub-model-config] failed to load model config:', error);
    return NextResponse.json({ models: [], planCardModels: [], version: 1 });
  }
};
