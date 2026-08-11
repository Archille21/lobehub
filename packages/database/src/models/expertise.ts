import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import {
  expertiseBindings,
  expertiseDomains,
  expertiseDomainSnapshots,
  expertiseHits,
  expertiseInsights,
  expertiseLessons,
  expertiseRuns,
} from '../schemas';
import type { LobeChatDatabase } from '../type';
import { buildWorkspaceWhere } from '../utils/workspace';

/**
 * 命中梯队的切点：本专长最高命中的 40%，下限 2。
 *
 * 用相对值而不是绝对阈值 —— 实测代码评审练了 47 次、UX 审计只练了 2 次，
 * 同一个绝对阈值必然误伤后者。
 */
const CORE_CUT_RATIO = 0.4;
const CORE_CUT_MIN = 2;

export type ExpertiseTier = 'core' | 'niche' | 'unused';

export class ExpertiseModel {
  private db: LobeChatDatabase;
  private userId: string;
  private workspaceId?: string;

  constructor(db: LobeChatDatabase, userId: string, workspaceId?: string) {
    this.db = db;
    this.userId = userId;
    this.workspaceId = workspaceId;
  }

  private scopeWhere = () =>
    buildWorkspaceWhere({ userId: this.userId, workspaceId: this.workspaceId }, expertiseDomains);

  // ========== 挂载解析 ==========

  /**
   * 一个 agent 能用到的专长。
   *
   * 挂载是叠加的：workspace 上挂的、project 上挂的、agent 上挂的都算。这里先做
   * agent + workspace 两级 —— project 级要等 agent 所属 project 的解析链路接上。
   */
  listDomainsForAgent = async (agentId: string) => {
    const rows = await this.db
      .select({
        binding: {
          contributionMode: expertiseBindings.contributionMode,
          enabled: expertiseBindings.enabled,
          id: expertiseBindings.id,
          sortOrder: expertiseBindings.sortOrder,
        },
        domain: expertiseDomains,
      })
      .from(expertiseBindings)
      .innerJoin(expertiseDomains, eq(expertiseDomains.id, expertiseBindings.domainId))
      .where(
        and(
          eq(expertiseBindings.enabled, true),
          or(
            eq(expertiseBindings.agentId, agentId),
            this.workspaceId
              ? eq(expertiseBindings.boundWorkspaceId, this.workspaceId)
              : eq(expertiseBindings.boundUserId, this.userId),
          ),
        ),
      )
      .orderBy(asc(expertiseBindings.sortOrder));

    // 同一个专长可能同时挂在 agent 和 workspace 上，去重保留排序靠前的那条绑定
    const seen = new Set<string>();
    return rows.filter((r) => {
      if (seen.has(r.domain.id)) return false;
      seen.add(r.domain.id);
      return true;
    });
  };

  // ========== L0：概览 ==========

  /**
   * 每个专长的最新快照 —— L0 的曲线、成熟度、覆盖率都读它。
   *
   * 用 DISTINCT ON 取每个 domain 的最大 runIndex，避免把整张时间序列拉回来。
   */
  latestSnapshots = async (domainIds: string[]) => {
    if (domainIds.length === 0) return [];
    return this.db
      .selectDistinctOn([expertiseDomainSnapshots.domainId])
      .from(expertiseDomainSnapshots)
      .where(inArray(expertiseDomainSnapshots.domainId, domainIds))
      .orderBy(desc(expertiseDomainSnapshots.domainId), desc(expertiseDomainSnapshots.runIndex));
  };

  /** 每个专长有哪些 agent 在学 —— L0 列表上直接显示。 */
  actorsByDomain = async (domainIds: string[]) => {
    if (domainIds.length === 0) return [];
    return this.db
      .selectDistinct({ actorId: expertiseRuns.actorId, domainId: expertiseRuns.domainId })
      .from(expertiseRuns)
      .where(and(inArray(expertiseRuns.domainId, domainIds), eq(expertiseRuns.actorType, 'agent')));
  };

  // ========== L1：专长详情 ==========

  findDomain = async (domainId: string) => {
    const [row] = await this.db
      .select()
      .from(expertiseDomains)
      .where(and(eq(expertiseDomains.id, domainId), this.scopeWhere()))
      .limit(1);
    return row;
  };

  /** 完整的时间序列 —— 累计曲线与柱状图都由它渲染。 */
  listSnapshots = async (domainId: string) =>
    this.db
      .select()
      .from(expertiseDomainSnapshots)
      .where(eq(expertiseDomainSnapshots.domainId, domainId))
      .orderBy(asc(expertiseDomainSnapshots.runIndex));

  listRuns = async (domainId: string, limit = 50) =>
    this.db
      .select()
      .from(expertiseRuns)
      .where(eq(expertiseRuns.domainId, domainId))
      .orderBy(desc(expertiseRuns.runIndex))
      .limit(limit);

  // ========== L2：规则库 ==========

  /**
   * 规则列表，按命中降序 —— 流水账按时间排，判断系统按命中排。
   * 梯队（骨干 / 专用 / 没用上的）在这里算好，避免前端重复实现切点逻辑。
   */
  listLessons = async (domainId: string, opts?: { layer?: string; search?: string }) => {
    const conditions = [
      eq(expertiseLessons.domainId, domainId),
      eq(expertiseLessons.status, 'active'),
    ];
    if (opts?.layer) conditions.push(eq(expertiseLessons.layer, opts.layer));
    if (opts?.search) {
      conditions.push(sql`${expertiseLessons.title} ILIKE ${`%${opts.search}%`}`);
    }

    const rows = await this.db
      .select()
      .from(expertiseLessons)
      .where(and(...conditions))
      .orderBy(desc(expertiseLessons.hitCount), asc(expertiseLessons.code));

    const maxHit = rows.reduce((a, r) => Math.max(a, r.hitCount), 0);
    const cut = Math.max(CORE_CUT_MIN, Math.round(maxHit * CORE_CUT_RATIO));

    return rows.map((r) => ({
      ...r,
      tier: (r.hitCount >= cut ? 'core' : r.hitCount > 0 ? 'niche' : 'unused') as ExpertiseTier,
    }));
  };

  /** 分层覆盖：哪几层有规则、哪几层是空的。空层是 canonical 分层照出来的真缺口。 */
  layerCounts = async (domainId: string) => {
    const rows = await this.db
      .select({ layer: expertiseLessons.layer, n: sql<number>`count(*)::int` })
      .from(expertiseLessons)
      .where(and(eq(expertiseLessons.domainId, domainId), eq(expertiseLessons.status, 'active')))
      .groupBy(expertiseLessons.layer);
    return Object.fromEntries(rows.filter((r) => r.layer).map((r) => [r.layer!, r.n]));
  };

  /** Canon 覆盖：哪些条目被锚过。锚不上的规则（null）单独计一格。 */
  canonAnchorCounts = async (domainId: string) => {
    const rows = await this.db
      .select({ anchor: expertiseLessons.canonAnchor, n: sql<number>`count(*)::int` })
      .from(expertiseLessons)
      .where(and(eq(expertiseLessons.domainId, domainId), eq(expertiseLessons.status, 'active')))
      .groupBy(expertiseLessons.canonAnchor);
    return {
      byKey: Object.fromEntries(rows.filter((r) => r.anchor).map((r) => [r.anchor!, r.n])),
      unanchored: rows.find((r) => !r.anchor)?.n ?? 0,
    };
  };

  // ========== L3：单条规则 ==========

  findLesson = async (lessonId: string) => {
    const [row] = await this.db
      .select()
      .from(expertiseLessons)
      .where(eq(expertiseLessons.id, lessonId))
      .limit(1);
    return row;
  };

  /**
   * 一条规则的命中记录 —— pass 是 ✅ 例子，violation 是 ❌ 例子。
   * 带上 run 的 subject，「最近一次在哪」可以直接点回那个 topic。
   */
  listLessonHits = async (lessonId: string, limit = 20) =>
    this.db
      .select({
        createdAt: expertiseHits.createdAt,
        example: expertiseHits.example,
        note: expertiseHits.note,
        outcome: expertiseHits.outcome,
        runIndex: expertiseRuns.runIndex,
        runTitle: expertiseRuns.subjectId,
        severity: expertiseHits.severity,
        subjectId: expertiseRuns.subjectId,
        subjectType: expertiseRuns.subjectType,
        where: expertiseHits.where,
      })
      .from(expertiseHits)
      .innerJoin(expertiseRuns, eq(expertiseRuns.id, expertiseHits.runId))
      .where(eq(expertiseHits.lessonId, lessonId))
      .orderBy(desc(expertiseHits.createdAt))
      .limit(limit);

  // ========== 洞察 ==========

  listInsights = async (domainIds: string[]) => {
    if (domainIds.length === 0) return [];
    return this.db
      .select()
      .from(expertiseInsights)
      .where(
        and(
          or(inArray(expertiseInsights.domainId, domainIds), isNull(expertiseInsights.domainId)),
          eq(expertiseInsights.status, 'active'),
          eq(expertiseInsights.userId, this.userId),
        ),
      )
      .orderBy(desc(expertiseInsights.confidence))
      .limit(10);
  };

  dismissInsight = async (insightId: string, reason?: string) =>
    this.db
      .update(expertiseInsights)
      .set({ dismissReason: reason, status: 'dismissed', updatedAt: new Date() })
      .where(and(eq(expertiseInsights.id, insightId), eq(expertiseInsights.userId, this.userId)));
}
