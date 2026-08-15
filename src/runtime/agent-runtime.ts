import type { Plugin } from '@deepseek-ai/cordis'

import {
  attachAgent,
  type AgentAttachmentOptions,
  type AgentAttachmentRequest,
  type SessionEventBatch,
} from './agent-attachment'
import { createRuntimePlugin, type RuntimeErrorReporter } from './cordis-runtime'

export interface AgentRuntimePluginOptions {
  readonly eventBatchSize?: number
  readonly onError?: RuntimeErrorReporter
  readonly onEvents: (
    batch: SessionEventBatch,
    signal: AbortSignal,
  ) => Promise<void> | void
  readonly request: AgentAttachmentRequest
}

export function createAgentRuntimePlugin(
  options: AgentRuntimePluginOptions,
): Plugin.Object<void> {
  const plugin = createRuntimePlugin({
    ...(options.onError === undefined ? {} : { reportError: options.onError }),
    start: async (ctx, signal) => {
      const attachmentOptions: AgentAttachmentOptions = {
        ...(options.eventBatchSize === undefined
          ? {}
          : { eventBatchSize: options.eventBatchSize }),
        ...(options.onError === undefined
          ? {}
          : { onError: (error: unknown) => options.onError?.(ctx, error) }),
        onEvents: options.onEvents,
        request: options.request,
        signal,
      }
      const attachment = await attachAgent(ctx, attachmentOptions)
      return () => attachment.dispose()
    },
  })
  plugin.inject = ['agentDefaultModel', 'agents']
  return plugin
}
