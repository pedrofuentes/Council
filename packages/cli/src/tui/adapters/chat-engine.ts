import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import { takeUntilAborted } from "../../cli/commands/chat/take-until-aborted.js";
import type { CouncilEngine, EngineEvent, SendOptions } from "../../engine/index.js";

const ABORTED_ENGINE_ERROR_CODE = "ABORTED";

export interface StreamTurnInput {
  readonly expertId: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

export interface StreamTurnResult {
  readonly text: string;
  readonly aborted: boolean;
}

export type ChatSendFn = Pick<CouncilEngine, "send">["send"];

export async function streamTurn(
  send: ChatSendFn,
  input: StreamTurnInput,
  onDelta: (chunk: string) => void,
): Promise<StreamTurnResult> {
  if (isAborted(input.signal)) {
    return { text: "", aborted: true };
  }

  const options: SendOptions =
    input.signal === undefined
      ? { expertId: input.expertId, prompt: input.prompt }
      : { expertId: input.expertId, prompt: input.prompt, signal: input.signal };
  let text = "";

  for await (const event of takeUntilAborted(send(options), input.signal)) {
    if (event.kind === "message.delta") {
      text += event.text;
      onDelta(event.text);
      continue;
    }

    if (event.kind === "message.complete") {
      continue;
    }

    if (isAbortEvent(event, input.signal)) {
      break;
    }

    throw new Error(toSingleLineDisplay(event.error.message));
  }

  return { text, aborted: isAborted(input.signal) };
}

/**
 * Read an abort signal's current state through a function boundary so the
 * TS control-flow analyzer does not narrow a later read away after the
 * early-return guard — the signal is live and can flip to aborted mid-stream.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isAbortEvent(
  event: Extract<EngineEvent, { readonly kind: "error" }>,
  signal: AbortSignal | undefined,
): boolean {
  return isAborted(signal) || event.error.code === ABORTED_ENGINE_ERROR_CODE;
}
