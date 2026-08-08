import type { ChatTopicMetadata, ChatTopicStatus } from '../../topic';

export interface TopicEntityFragments {
  activity: { updatedAt: Date | number | string };
  analytics: { metadata: ChatTopicMetadata | null };
  completion: { completedAt: Date | null };
  creation: { createdAt?: Date | number | string };
  details: {
    description: string | null;
    firstUserMessage: string | null;
    messageCount: number | null;
  };
  display: { title: string };
  generation: { model: string | null; provider: string | null };
  marking: { favorite: boolean };
  navigation: { routePath?: string };
  ordering: { sortUpdatedAt: number };
  ownership: { userId?: string };
  preview: { description?: string | null; lastAssistantMessage?: string | null };
  routing: { agentId?: string | null };
  runTiming: { runStartedAt?: Date | null };
  status: { status?: ChatTopicStatus | null };
  summary: { historySummary: string | null };
  triggerInfo: { trigger?: string | null };
}
