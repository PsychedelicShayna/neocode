import type { NeoPiNavigateTreeInput, ScopedThreadRef } from "@t3tools/contracts";
import {
  nativeIdentityKey,
  nativeNavigationGuards,
} from "@t3tools/client-runtime/neopi-conversation";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { NativeJson } from "./NeoPiJournalContent";
import { restoreNativeDraft } from "./neopiNativeDraft";
import { nativeAskQuestions, nativeAskReanswer } from "@t3tools/client-runtime/neopi-tree";
import { nativeConversationAtoms, useNeoPiConversation } from "./useNeoPiConversation";
import { nativeTreeSessionKey, useNativeTreeField, type NativeAnswerImage } from "./neopiTreeState";

export function NeoPiTreeNavigation({
  threadRef,
  targetId,
  onNavigated,
}: {
  threadRef: ScopedThreadRef;
  targetId: string;
  onNavigated: () => void;
}) {
  const { conversation, connection, refresh } = useNeoPiConversation(threadRef);
  const navigate = useAtomCommand(nativeConversationAtoms.navigate, { reportFailure: false });
  const resume = useAtomCommand(nativeConversationAtoms.resume, { reportFailure: false });
  const cancel = useAtomCommand(nativeConversationAtoms.cancel, { reportFailure: false });
  const identity = conversation.identity;
  const sessionKey = nativeTreeSessionKey(threadRef.environmentId, identity);
  const stateKey = JSON.stringify([sessionKey, targetId]);
  const [summarize, setSummarize] = useNativeTreeField(stateKey, "summarize");
  const [instructions, setInstructions] = useNativeTreeField(stateKey, "instructions");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useNativeTreeField(stateKey, "message");
  const [result, setResult] = useNativeTreeField(stateKey, "result");
  const [answers, setAnswers] = useNativeTreeField(stateKey, "answers");
  const [images, setImages] = useNativeTreeField(stateKey, "images");
  const [resumeResult, setResumeResult] = useNativeTreeField(sessionKey, "resumeResult");
  const current = useRef(identity);
  current.current = identity;
  const origin = useRef<string | null>(null);
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  useEffect(() => {
    request.current++;
    setPending(false);
  }, [stateKey]);
  useEffect(() => {
    if (identity && origin.current && nativeIdentityKey(identity) !== origin.current) {
      origin.current = null;
      request.current++;
      setPending(false);
      setMessage(
        "The native session changed. Select a node in its current tree before navigating.",
      );
    }
  }, [identity]);
  useEffect(() => {
    if (result?.outcome === "ask_reopen" && identity && result.leafId !== identity.leafId) {
      setResult(null);
      setAnswers({});
      setImages([]);
      setMessage(
        "The native branch changed while this question was open. Reopen it from the current tree.",
      );
    }
  }, [identity, result]);
  const ask = useMemo(() => {
    if (!result?.reopenAsk) return null;
    try {
      return { questions: nativeAskQuestions(result.reopenAsk.questions), error: null };
    } catch (cause) {
      return {
        questions: [],
        error: cause instanceof Error ? cause.message : "Unsupported native questions.",
      };
    }
  }, [result]);
  const canNavigate =
    connection?.status === "connected" &&
    connection.canNavigate &&
    identity &&
    !conversation.needsSnapshot;

  const perform = async (
    reanswerAskResult?: NeoPiNavigateTreeInput["reanswerAskResult"],
    startIfStopped = false,
  ) => {
    if (!identity || (!canNavigate && !startIfStopped) || pending) return;
    const generation = ++request.current;
    origin.current = nativeIdentityKey(identity);
    setPending(true);
    setMessage(null);
    try {
      const response = await navigate({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          ...nativeNavigationGuards(identity),
          targetId,
          summarize,
          ...(instructions.trim() ? { customInstructions: instructions } : {}),
          allowAskReopen: true,
          ...(startIfStopped ? { startIfStopped: true } : {}),
          ...(reanswerAskResult ? { reanswerAskResult } : {}),
        },
      });
      if (
        generation !== request.current ||
        !current.current ||
        nativeIdentityKey(current.current) !== origin.current
      )
        return;
      if (response._tag === "Failure") {
        if (isAtomCommandInterrupted(response)) {
          setMessage("Navigation request interrupted. Refresh to observe the native leaf.");
          return;
        }
        throw squashAtomCommandFailure(response);
      }
      if (response.value.status !== "available")
        throw new Error(
          response.value.status === "error"
            ? `${response.value.code}: ${response.value.message}`
            : response.value.reason,
        );
      const next = response.value.result;
      setResult(next);
      if (next.resumeToken) setResumeResult(next);
      if (startIfStopped) refresh();
      if (next.outcome === "navigated" || next.outcome === "unchanged") {
        try {
          restoreNativeDraft(threadRef, next);
        } catch (cause) {
          refresh();
          onNavigated();
          setMessage(
            `Native navigation completed, but its draft could not be restored: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
          return;
        }
      }
      if (next.outcome === "cancelled")
        setMessage(
          next.aborted
            ? "Navigation cancelled. The branch did not move."
            : "Native navigation was cancelled. The branch did not move.",
        );
      else if (next.outcome === "unchanged") setMessage("The native leaf is unchanged.");
      else if (next.outcome === "ask_reopen")
        setMessage("Answer the reopened native question below. The branch has not moved.");
      else {
        setMessage(
          next.askReanswerCommitted
            ? "The new answer is saved on its branch. Waiting for the transcript to rebuild before resuming."
            : "Native branch selected. Alternate branches remain in the same file.",
        );
        refresh();
        onNavigated();
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Native navigation failed.");
    } finally {
      if (generation === request.current) setPending(false);
    }
  };
  const rebuilt =
    resumeResult?.resumeToken &&
    identity &&
    !conversation.needsSnapshot &&
    identity.sessionId === resumeResult.sessionId &&
    identity.leafId === resumeResult.leafId &&
    conversation.entries.some((entry) => entry.id === resumeResult.leafId);
  const acknowledge = async () => {
    if (!resumeResult?.resumeToken || !rebuilt || !identity || pending) return;
    const generation = ++request.current;
    setPending(true);
    try {
      const response = await resume({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          ...nativeNavigationGuards(identity),
          resumeToken: resumeResult.resumeToken,
        },
      });
      if (generation !== request.current) return;
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      if (response.value.status !== "available")
        throw new Error(
          response.value.status === "error" ? response.value.message : response.value.reason,
        );
      setResumeResult(null);
      setResult(null);
      setMessage("Native continuation acknowledged after the transcript rebuilt.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not resume the native session.");
    } finally {
      if (generation === request.current) setPending(false);
    }
  };
  const addImages = async (files: FileList | null) => {
    if (!files) return;
    const generation = request.current;
    try {
      const next = await Promise.all(
        Array.from(files).map(async (file): Promise<NativeAnswerImage> => {
          if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(file.type))
            throw new Error(`Unsupported image type: ${file.type || file.name}`);
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () =>
              typeof reader.result === "string"
                ? resolve(reader.result.slice(reader.result.indexOf(",") + 1))
                : reject(new Error("Could not read image."));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          });
          return { type: "image", data, mimeType: file.type };
        }),
      );
      if (generation === request.current) setImages((previous) => [...previous, ...next]);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not read answer images.");
    }
  };

  return (
    <section className="my-4 space-y-3 border-y py-4" aria-label="Navigate native tree">
      <p className="text-xs text-muted-foreground">
        Navigation uses NeoPi's tree operation in this file. Selecting a user entry restores its
        draft instead of deleting its future.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={summarize}
          disabled={pending}
          onChange={(event) => setSummarize(event.currentTarget.checked)}
        />
        Carry a native summary into the selected branch
      </label>
      {summarize ? (
        <label className="block text-xs">
          Summary instructions
          <textarea
            className="mt-1 block w-full rounded border bg-background p-2"
            value={instructions}
            disabled={pending}
            onChange={(event) => setInstructions(event.currentTarget.value)}
          />
        </label>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!canNavigate || pending}
          onClick={() => void perform()}
        >
          Navigate here
        </Button>
        {!canNavigate && identity && !conversation.needsSnapshot ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void perform(undefined, true)}
          >
            Start stopped native session and navigate
          </Button>
        ) : null}
        {pending ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void (async () => {
                const response = await cancel({
                  environmentId: threadRef.environmentId,
                  input: { threadId: threadRef.threadId },
                });
                setMessage(
                  response._tag === "Success" && response.value.status === "available"
                    ? "Cancellation requested. Waiting for the native outcome."
                    : "Could not request cancellation. Refresh to inspect the native leaf.",
                );
              })()
            }
          >
            Cancel navigation
          </Button>
        ) : null}
      </div>
      {!canNavigate ? (
        <p className="text-xs text-muted-foreground">
          {connection?.reason ?? "Navigation requires a connected native owner with tree support."}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      {result ? <NativeJson value={result} label="Native navigation result" /> : null}
      {ask ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (ask.error) return;
            try {
              const answer = nativeAskReanswer(ask.questions, answers);
              void perform({ ...answer, content: [...answer.content, ...images] });
            } catch (cause) {
              setMessage(cause instanceof Error ? cause.message : "Could not submit the answer.");
            }
          }}
        >
          {ask.error ? (
            <p role="alert" className="text-sm text-destructive">
              {ask.error}
            </p>
          ) : (
            ask.questions.map((question) => {
              const answer = answers[question.id] ?? { selectedOptions: [], customInput: "" };
              return (
                <fieldset key={question.id} disabled={pending} className="space-y-2">
                  <legend className="text-sm font-medium">{question.question}</legend>
                  {question.options.map((option) => (
                    <label key={option.label} className="block text-sm">
                      <input
                        type={question.multi ? "checkbox" : "radio"}
                        name={question.id}
                        checked={answer.selectedOptions.includes(option.label)}
                        onChange={(event) =>
                          setAnswers((previous) => ({
                            ...previous,
                            [question.id]: {
                              ...answer,
                              selectedOptions: question.multi
                                ? event.currentTarget.checked
                                  ? [...answer.selectedOptions, option.label]
                                  : answer.selectedOptions.filter((value) => value !== option.label)
                                : [option.label],
                            },
                          }))
                        }
                      />{" "}
                      {option.label}
                      {option.description ? (
                        <span className="block pl-5 text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      ) : null}
                      {option.preview ? (
                        <pre className="overflow-auto whitespace-pre-wrap pl-5 text-xs">
                          {option.preview}
                        </pre>
                      ) : null}
                    </label>
                  ))}
                  <label className="block text-xs">
                    Free answer / additional text
                    <textarea
                      className="mt-1 block w-full rounded border bg-background p-2"
                      value={answer.customInput}
                      onChange={(event) =>
                        setAnswers((previous) => ({
                          ...previous,
                          [question.id]: { ...answer, customInput: event.currentTarget.value },
                        }))
                      }
                    />
                  </label>
                </fieldset>
              );
            })
          )}
          <label className="block text-xs">
            Answer images, in selection order
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
              multiple
              disabled={pending}
              onChange={(event) => {
                void addImages(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
            />
          </label>
          {images.map((image, index) => (
            <div key={index} className="flex items-center gap-2">
              <img
                src={`data:${image.mimeType};base64,${image.data}`}
                alt={`Answer attachment ${index + 1}`}
                className="max-h-24 max-w-32"
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  setImages((previous) => previous.filter((_, position) => position !== index))
                }
              >
                Remove image {index + 1}
              </Button>
            </div>
          ))}
          <NativeJson value={result?.reopenAsk} label="Native ask record" />
          <Button type="submit" size="sm" disabled={pending || !canNavigate || !!ask.error}>
            Save new answer on this branch
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setResult(null);
              setAnswers({});
              setImages([]);
              setMessage("Re-answer cancelled. The branch is unchanged.");
            }}
          >
            Cancel re-answer
          </Button>
        </form>
      ) : null}
      {resumeResult?.resumeToken ? (
        <div className="space-y-2">
          {!rebuilt ? (
            <p className="text-xs text-muted-foreground">
              Resume is available only after the transcript matches the saved answer's native leaf.
              An intervening branch change or owner restart can invalidate this continuation.
            </p>
          ) : null}
          <Button
            size="sm"
            disabled={!rebuilt || pending || connection?.status !== "connected"}
            onClick={() => void acknowledge()}
          >
            Resume after rebuilt transcript
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setResumeResult(null);
              setMessage("The saved answer remains on its branch. No continuation was requested.");
            }}
          >
            Keep answer without resuming
          </Button>
        </div>
      ) : null}
    </section>
  );
}
