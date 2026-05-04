export { PreferenceExtractor } from './src/enrichment/preference_extractor';
export type { PreferenceCandidate } from './src/enrichment/preference_extractor';
export {
  TOPIC_EXTRACTOR_SYSTEM_PROMPT,
  TopicExtractor,
} from './src/enrichment/topic_extractor';
export type {
  TopicExtractorInput,
  TopicExtractionResult,
  TopicExtractorLLM,
} from './src/enrichment/topic_extractor';
export { touchTopicsForItem } from './src/enrichment/topic_touch_pipeline';
export type {
  ContactResolver,
  ResolvedContact,
  TopicTouchCoreClient,
  TopicTouchPipelineOptions,
  TopicTouchResult,
  TouchableItem,
} from './src/enrichment/topic_touch_pipeline';
