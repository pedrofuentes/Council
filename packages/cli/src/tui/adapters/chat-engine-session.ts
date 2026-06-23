import type { CouncilEngine, ExpertSpec } from "../../engine/index.js";
import type { ChatSendFn } from "./chat-engine.js";

export interface ChatEngineHandle {
  readonly send: ChatSendFn;
  readonly expertId: string;
  close(): Promise<void>;
}

export interface ChatEngineSessionDeps {
  readonly engineFactory: () => CouncilEngine;
  readonly buildSpec: (slug: string) => Promise<ExpertSpec>;
}

export interface ChatEngineSource {
  open(expertSlug: string): Promise<ChatEngineHandle>;
}

export function createChatEngineSource(deps: ChatEngineSessionDeps): ChatEngineSource {
  return {
    async open(expertSlug: string): Promise<ChatEngineHandle> {
      const spec = await deps.buildSpec(expertSlug);
      const engine = deps.engineFactory();
      try {
        await engine.start();
        await engine.addExpert(spec);
      } catch (error) {
        await engine.stop();
        throw error;
      }

      return {
        expertId: spec.id,
        send: (options) => engine.send(options),
        close: () => engine.stop(),
      };
    },
  };
}
