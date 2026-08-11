/**
 * Expertise —— SCLPT 自进化体系的共享类型。
 *
 * 这些形状同时被 DB schema、reflection 工具和前端消费，所以放在 types 里而不是
 * 就地内联：一处改动三处必须同步。
 */

/**
 * 分层模型的一层。归属于专长而不是全局枚举 —— Cooper 三模型、
 * 正确性/可维护性/安全性、L1/L2/L3 各不相同。
 */
export interface ExpertiseLayerDefinition {
  /** 这一层抄的哪本经典。缺失意味着这层是自己发明的。 */
  canonRef?: string;
  description?: string;
  /** 稳定 key，被 lessons.layer 和 snapshots.layerCounts 引用。 */
  key: string;
  title: string;
}

export type ExpertiseEvidenceKind = 'image' | 'text' | 'diff' | 'json' | 'metric';

/**
 * 一次实践必须留下的一项证据。挂了 layer 的条目只在跑那一层时要求 ——
 * 例如 screenshot 挂在 L2 且 required，没截图就不允许下 L2 的结论。
 */
export interface ExpertiseEvidenceSpecItem {
  key: string;
  kind: ExpertiseEvidenceKind;
  label: string;
  /** 只在跑这一层时要求；不填表示每次都要求。 */
  layer?: string;
  required: boolean;
}

/** 三种极性各自的四段 key。对话改写按 key 定位，只改其中一段。 */
export const EXPERTISE_SECTION_KEYS = {
  /** 这样是对的 / 为什么管用 / 别退化成什么 */
  good: ['good', 'works', 'dont'],
  /** 判据是什么 / 为什么 / 怎么用 / 什么时候不适用 */
  rule: ['rule', 'why', 'how', 'limits'],
  /** 错的做法 / 为什么错 / 会坏什么 / 对的做法 */
  bad: ['wrong', 'why', 'breaks', 'correct'],
} as const;

export type ExpertiseLessonPolarity = keyof typeof EXPERTISE_SECTION_KEYS;

export interface ExpertiseLessonSection {
  body: string;
  /** 取自 EXPERTISE_SECTION_KEYS[polarity]。 */
  key: string;
}

export type ExpertiseInsightEvidenceType = 'lesson' | 'run' | 'hit' | 'topic' | 'operation';

export interface ExpertiseInsightEvidenceRef {
  ids: string[];
  type: ExpertiseInsightEvidenceType;
}
