import React from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useNavigate, useParams } from "react-router";

import { stripControlChars, toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import { streamTurn } from "../adapters/chat-engine.js";
import type { PanelChatHandle } from "../adapters/chat-engine-session.js";
import { useData } from "../components/DataProvider.js";
import { useInputCapture } from "../components/InputCaptureProvider.js";
import { ScrollView } from "../components/lists/ScrollView.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface PanelChatScreenProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
}

interface TranscriptTurn {
  readonly id: string;
  readonly role: "user" | "expert" | "notice";
  readonly expertSlug: string | null;
  readonly content: string;
}

interface PanelMember {
  readonly slug: string;
  readonly expertId: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderTurn(turn: TranscriptTurn): string {
  if (turn.role === "notice") return stripControlChars(turn.content);
  const label = turn.role === "user" ? "You" : (turn.expertSlug ?? "panel");
  return `${toSingleLineDisplay(label)}: ${stripControlChars(turn.content)}`;
}

function findMember(handle: PanelChatHandle, targetSlug: string): PanelMember | undefined {
  return handle.members.find((member) => member.slug === targetSlug);
}

export function PanelChatScreen(props: PanelChatScreenProps): React.ReactElement {
  const { name = "" } = useParams();
  const navigate = useNavigate();
  const data = useData();
  const { setCaptured } = useInputCapture();
  const panels = data.panels;
  const chat = data.chat;
  const chatEngine = data.chatEngine;
  const [message, setMessage] = React.useState("");
  const [transcript, setTranscript] = React.useState<readonly TranscriptTurn[]>([]);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [isStreaming, setIsStreaming] = React.useState(false);
  const handleRef = React.useRef<PanelChatHandle | undefined>(undefined);
  const sessionIdRef = React.useRef<string | undefined>(undefined);
  const memberSlugsRef = React.useRef<readonly string[]>([]);
  const streamingRef = React.useRef(false);
  const controllerRef = React.useRef<AbortController | undefined>(undefined);
  const unmountedRef = React.useRef(false);
  const generationRef = React.useRef(0);
  const turnIdRef = React.useRef(0);

  React.useEffect(() => {
    setCaptured(true);
    return () => {
      setCaptured(false);
    };
  }, [setCaptured]);

  const setTranscriptIfMounted = React.useCallback(
    (update: React.SetStateAction<readonly TranscriptTurn[]>, generation?: number): void => {
      if (
        !unmountedRef.current &&
        (generation === undefined || generationRef.current === generation)
      ) {
        setTranscript(update);
      }
    },
    [],
  );

  const isCurrentGeneration = React.useCallback((generation: number): boolean => {
    return !unmountedRef.current && generationRef.current === generation;
  }, []);

  React.useEffect(() => {
    unmountedRef.current = false;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    streamingRef.current = false;
    controllerRef.current = undefined;
    memberSlugsRef.current = [];
    setIsStreaming(false);
    let cancelled = false;

    if (chat === undefined || chatEngine === undefined) {
      setError(toSingleLineDisplay("panel chat unavailable"));
      return () => {
        unmountedRef.current = true;
      };
    }

    let openPromise: Promise<PanelChatHandle> | undefined;
    void (async (): Promise<void> => {
      try {
        const detail = await panels.loadDetail(name, "saved");
        if (detail === undefined) throw new Error(`Panel "${name}" not found`);
        const memberSlugs = detail.members.map((member) => member.slug);
        memberSlugsRef.current = memberSlugs;
        openPromise = chatEngine.openPanel(memberSlugs);
        const history = await chat.loadHistory("panel", name);
        const handle = await openPromise;
        if (cancelled || !isCurrentGeneration(generation)) {
          await handle.close();
          return;
        }
        sessionIdRef.current = history.session?.id;
        handleRef.current = handle;
        setTranscript(
          history.turns.map((turn) => ({
            id: turn.id,
            role: turn.role,
            expertSlug: turn.expertSlug,
            content: turn.content,
          })),
        );
      } catch (loadError) {
        await openPromise?.then((handle) => handle.close()).catch(() => undefined);
        if (!cancelled && isCurrentGeneration(generation)) {
          setError(toSingleLineDisplay(errorMessage(loadError)));
        }
      }
    })();

    return () => {
      cancelled = true;
      unmountedRef.current = true;
      controllerRef.current?.abort();
      const handle = handleRef.current;
      handleRef.current = undefined;
      if (handle !== undefined) void handle.close();
    };
  }, [chat, chatEngine, isCurrentGeneration, name, panels]);

  const submit = React.useCallback(
    (value: string): void => {
      const prompt = value.trim();
      const handle = handleRef.current;
      if (
        prompt.length === 0 ||
        streamingRef.current ||
        handle === undefined ||
        chat === undefined
      ) {
        return;
      }

      const parsed = chat.route(prompt, memberSlugsRef.current);
      if (parsed.type === "convene") {
        setMessage("");
        setTranscriptIfMounted((current) => [
          ...current,
          {
            id: `notice-${String(turnIdRef.current)}`,
            role: "notice",
            expertSlug: null,
            content: "convene from chat is coming in 9.8",
          },
        ]);
        turnIdRef.current += 1;
        return;
      }

      const members = parsed.type === "mention" ? parsed.targetSlugs : memberSlugsRef.current;
      const targets = members
        .map((targetSlug) => findMember(handle, targetSlug))
        .filter((member): member is PanelMember => member !== undefined);
      if (targets.length === 0) return;

      streamingRef.current = true;
      setIsStreaming(true);
      setError(undefined);
      setMessage("");
      const controller = new AbortController();
      controllerRef.current = controller;
      const turnId = turnIdRef.current;
      turnIdRef.current += 1;
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      const assistantTurns = targets.map((target) => ({
        id: `assistant-${String(turnId)}-${target.slug}`,
        role: "expert" as const,
        expertSlug: target.slug,
        content: "",
      }));
      setTranscriptIfMounted((current) => [
        ...current,
        { id: `user-${String(turnId)}`, role: "user", expertSlug: null, content: prompt },
        ...assistantTurns,
      ]);

      void (async (): Promise<void> => {
        try {
          for (const target of targets) {
            if (!isCurrentGeneration(generation)) return;
            const assistantId = `assistant-${String(turnId)}-${target.slug}`;
            const result = await streamTurn(
              handle.send,
              { expertId: target.expertId, prompt: parsed.content, signal: controller.signal },
              (chunk) => {
                setTranscriptIfMounted(
                  (current) =>
                    current.map((turn) =>
                      turn.id === assistantId
                        ? { ...turn, content: `${turn.content}${chunk}` }
                        : turn,
                    ),
                  generation,
                );
              },
            );
            if (!isCurrentGeneration(generation)) return;
            if (!result.aborted) {
              const session =
                sessionIdRef.current === undefined
                  ? await chat.ensureSession("panel", name)
                  : { id: sessionIdRef.current };
              if (!isCurrentGeneration(generation)) return;
              sessionIdRef.current = session.id;
              await chat.persistTurn(session.id, {
                userContent: prompt,
                expertSlug: target.slug,
                expertContent: result.text,
                isMention: parsed.type === "mention",
              });
            }
          }
        } catch (streamError) {
          if (isCurrentGeneration(generation)) {
            setError(toSingleLineDisplay(`Stream failed: ${errorMessage(streamError)}`));
          }
        } finally {
          if (isCurrentGeneration(generation)) {
            streamingRef.current = false;
            controllerRef.current = undefined;
            setIsStreaming(false);
          }
        }
      })();
    },
    [chat, isCurrentGeneration, name, setTranscriptIfMounted],
  );

  useInput(
    (_input, key) => {
      if (!key.escape) return;
      if (streamingRef.current) {
        controllerRef.current?.abort();
        return;
      }
      navigate(-1);
    },
    { isActive: props.isActive ?? false },
  );

  if (chat === undefined || chatEngine === undefined) {
    return <Text>{props.theme.error(toSingleLineDisplay("panel chat unavailable"))}</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text>{props.theme.accent(`Panel chat ${toSingleLineDisplay(name)}`)}</Text>
      <ScrollView items={transcript.map((turn) => renderTurn(turn))} height={12} follow />
      {isStreaming ? <Text>{props.theme.muted("Thinking…")}</Text> : null}
      {error !== undefined ? <Text>{props.theme.error(error)}</Text> : null}
      <Box>
        <Text>{props.theme.accent("Message: ")}</Text>
        <TextInput
          focus={props.isActive ?? false}
          value={toSingleLineDisplay(message)}
          onChange={setMessage}
          onSubmit={submit}
        />
      </Box>
    </Box>
  );
}
