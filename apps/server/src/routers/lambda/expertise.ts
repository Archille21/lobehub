import { z } from 'zod';

import { ExpertiseModel } from '@/database/models/expertise';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

const expertiseProcedure = authedProcedure.use(serverDatabase).use(async (opts) => {
  const { ctx } = opts;
  return opts.next({
    ctx: {
      expertiseModel: new ExpertiseModel(ctx.serverDB, ctx.userId, ctx.workspaceId ?? undefined),
    },
  });
});

/**
 * 拟合结果只有在可信时才交给界面。
 *
 * 有三种「没有成熟度」，界面文案各不相同：
 *   fitComputedAt 为空       → 还在算
 *   fitConfidence 非 ok      → 样本太少 / 噪声 / 拟合失败，算不出
 *   tauPinned                → τ 撞了搜索上界，pInf 是边界伪影
 * 任何一种都不能给出百分比 —— 9 组回测里 6 组撞界，旧版把它们全报成了 ok。
 */
const toMaturity = (s?: {
  fitComputedAt: Date | null;
  fitConfidence: string | null;
  maturity: number | null;
  observedSpan: number | null;
  pInf: number | null;
  plateauKind: string | null;
  tau: number | null;
  tauPinned: boolean;
}) => {
  if (!s) return { reason: 'no-data' as const, usable: false as const };
  if (!s.fitComputedAt) return { reason: 'pending' as const, usable: false as const };
  if (s.tauPinned) return { reason: 'tau-pinned' as const, usable: false as const };
  if (s.fitConfidence !== 'ok') {
    return {
      plateauKind: s.plateauKind,
      reason: 'low-confidence' as const,
      usable: false as const,
    };
  }
  return {
    maturity: s.maturity,
    /** < 1 表示还没观测满一个时间常数，渐近线没被数据约束住，外推只是猜测。 */
    observedSpan: s.observedSpan,
    pInf: s.pInf,
    plateauKind: s.plateauKind,
    speculative: (s.observedSpan ?? 0) < 1,
    tau: s.tau,
    usable: true as const,
  };
};

export const expertiseRouter = router({
  /** L0 —— 一个 agent 能用到的全部专长 + 各自最新状态。 */
  listByAgent: expertiseProcedure
    .input(z.object({ agentId: z.string() }))
    .query(async ({ ctx, input }) => {
      const bound = await ctx.expertiseModel.listDomainsForAgent(input.agentId);
      const domainIds = bound.map((b) => b.domain.id);
      const [snapshots, actors, insights] = await Promise.all([
        ctx.expertiseModel.latestSnapshots(domainIds),
        ctx.expertiseModel.actorsByDomain(domainIds),
        ctx.expertiseModel.listInsights(domainIds),
      ]);
      const snapByDomain = new Map(snapshots.map((s) => [s.domainId, s]));
      const actorsByDomain = new Map<string, string[]>();
      for (const a of actors) {
        actorsByDomain.set(a.domainId, [...(actorsByDomain.get(a.domainId) ?? []), a.actorId]);
      }

      return {
        domains: bound.map(({ binding, domain }) => {
          const snap = snapByDomain.get(domain.id);
          return {
            activeRate: snap?.activeRate ?? null,
            actors: actorsByDomain.get(domain.id) ?? [],
            /** 人还没定锚点时，这个专长不该开始长规则 —— 界面据此显示待确认。 */
            anchorPending: !domain.anchorChosenAt,
            canonCoverage: snap?.canonCoverage ?? null,
            contributionMode: binding.contributionMode,
            id: domain.id,
            layerCounts: snap?.layerCounts ?? {},
            layers: domain.layers,
            layerSource: domain.layerSource,
            lessonCount: snap?.activeCount ?? 0,
            layerCoverage: snap?.layerCoverage ?? null,
            maturity: toMaturity(snap),
            runCount: snap?.runIndex ?? 0,
            slug: domain.slug,
            title: domain.title,
            /** 最近一次实践的时间 —— 用来判断这个专长是不是闲置了。 */
            lastPracticedAt: snap?.capturedAt ?? null,
          };
        }),
        insights,
      };
    }),

  /** L1 —— 一个专长的完整状态：SCLPT 五要素 + 时间序列。 */
  getDomain: expertiseProcedure
    .input(z.object({ domainId: z.string() }))
    .query(async ({ ctx, input }) => {
      const domain = await ctx.expertiseModel.findDomain(input.domainId);
      if (!domain) return null;

      const [snapshots, runs, layerCounts, canon] = await Promise.all([
        ctx.expertiseModel.listSnapshots(input.domainId),
        ctx.expertiseModel.listRuns(input.domainId),
        ctx.expertiseModel.layerCounts(input.domainId),
        ctx.expertiseModel.canonAnchorCounts(input.domainId),
      ]);
      const latest = snapshots.at(-1);

      return {
        canonAnchorCounts: canon.byKey,
        domain,
        layerCounts,
        maturity: toMaturity(latest),
        runs,
        /** 曲线只需要这几列，别把整行快照塞给前端。 */
        series: snapshots.map((s) => ({
          activeCount: s.activeCount,
          compiledCount: s.compiledCount,
          runIndex: s.runIndex,
        })),
        unanchoredCount: canon.unanchored,
      };
    }),

  /** L2 —— 规则库，按命中排，梯队在服务端算好。 */
  listLessons: expertiseProcedure
    .input(
      z.object({
        domainId: z.string(),
        layer: z.string().optional(),
        search: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) =>
      ctx.expertiseModel.listLessons(input.domainId, {
        layer: input.layer,
        search: input.search,
      }),
    ),

  /** L3 —— 单条规则，带上它的 ✅❌ 例子。 */
  getLesson: expertiseProcedure
    .input(z.object({ lessonId: z.string() }))
    .query(async ({ ctx, input }) => {
      const lesson = await ctx.expertiseModel.findLesson(input.lessonId);
      if (!lesson) return null;
      const hits = await ctx.expertiseModel.listLessonHits(input.lessonId);
      return { hits, lesson };
    }),

  /** 洞察是分析产物，会出错 —— 必须能被否掉。 */
  dismissInsight: expertiseProcedure
    .input(z.object({ insightId: z.string(), reason: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.expertiseModel.dismissInsight(input.insightId, input.reason);
    }),
});
