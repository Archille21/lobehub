export interface CreateVideoState {
  editingGenerationId?: string;
  isCreating: boolean;
  isCreatingWithNewTopic: boolean;
}

export const initialCreateVideoState: CreateVideoState = {
  editingGenerationId: undefined,
  isCreating: false,
  isCreatingWithNewTopic: false,
};
