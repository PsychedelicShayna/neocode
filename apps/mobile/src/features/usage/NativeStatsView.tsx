import type { NativeStatsTransportInput } from "@t3tools/client-runtime/neopi-stats-bridge";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { randomUUID } from "expo-crypto";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { WebView } from "react-native-webview";

import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { nativeStatsRequest } from "../../state/neopiStats";
import { useAtomCommand } from "../../state/use-atom-command";
import { createMobileStatsBridge, nativeStatsDocument } from "./neopi-stats-document";

const DOCUMENT_ORIGIN = "https://neocode-stats.invalid/";

export function NativeStatsView(props: { environmentId: EnvironmentId; instanceId: ProviderInstanceId }) {
  const [attempt, setAttempt] = useState(0);
  return <StatsDocument key={`${props.environmentId}:${props.instanceId}:${attempt}`} {...props} onRetry={() => setAttempt((value) => value + 1)} />;
}

function StatsDocument({ environmentId, instanceId, onRetry }: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  onRetry: () => void;
}) {
  const request = useAtomCommand(nativeStatsRequest, { reportFailure: false });
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const webView = useRef<WebView>(null);
  const session = useRef<{ receive: (raw: string) => void; stop: () => void } | null>(null);
  useEffect(() => {
    let active = true;
    let stopped = false;
    const identity = { viewId: randomUUID(), bridgeId: randomUUID() };
    const lifetime = new AbortController();
    const bridge = createMobileStatsBridge({
      bridgeId: identity.bridgeId,
      lifetime: lifetime.signal,
      inject: (script) => webView.current?.injectJavaScript(script),
      execute: async (input: NativeStatsTransportInput) => {
        const result = await request({ environmentId, input: { ...input, instanceId, viewId: identity.viewId } });
        return result._tag === "Success";
      },
    });
    const current = {
      receive: bridge.receive,
      stop: () => {
        if (stopped) return;
        stopped = true;
        lifetime.abort();
        bridge.dispose();
        void request({ environmentId, input: {
          instanceId, viewId: identity.viewId, path: "/", method: "DELETE", signal: new AbortController().signal,
          consume: async (response) => { await response.body?.cancel(); },
        } });
      },
    };
    session.current = current;
    setHtml(null);
    setError(null);
    void (async () => {
      try {
        let document: string | null = null;
        const result = await request({ environmentId, input: {
          instanceId, viewId: identity.viewId, path: "/embed", method: "GET", signal: lifetime.signal,
          consume: async (response) => {
            if (!response.ok) throw new Error(`Native NeoPi stats is unavailable (HTTP ${response.status}). ${await response.text()}`);
            document = nativeStatsDocument(await response.text(), identity.bridgeId);
          },
        } });
        if (!active || lifetime.signal.aborted) return;
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        if (document === null) throw new Error("Native NeoPi stats did not return a document.");
        setHtml(document);
      } catch (cause) {
        if (!active || lifetime.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Native NeoPi stats could not load.");
        current.stop();
      }
    })();
    return () => {
      active = false;
      current.stop();
      if (session.current === current) session.current = null;
    };
  }, [environmentId, instanceId, request]);
  const fail = (message: string) => {
    session.current?.stop();
    setHtml(null);
    setError(message);
  };
  const source = useMemo(() => html === null ? null : ({ html, baseUrl: DOCUMENT_ORIGIN }), [html]);
  if (error) return (
    <View className="flex-1 items-center justify-center gap-4 px-5">
      <Text accessibilityRole="alert" selectable className="text-center text-danger-foreground">{error}</Text>
      <MaterialButton label="Retry native stats" onPress={onRetry} />
    </View>
  );
  if (source === null) return <View className="flex-1 items-center justify-center gap-3"><ActivityIndicator /><Text className="text-foreground-muted">Opening native NeoPi stats…</Text></View>;
  return <WebView
    ref={webView}
    source={source}
    originWhitelist={["*"]}
    sharedCookiesEnabled={false}
    setSupportMultipleWindows={false}
    style={{ flex: 1, backgroundColor: "transparent" }}
    onShouldStartLoadWithRequest={(event) => event.url === "about:blank" || event.url.split("#", 1)[0] === DOCUMENT_ORIGIN}
    onMessage={(event) => {
      if (event.nativeEvent.url === "about:blank" || event.nativeEvent.url.split("#", 1)[0] === DOCUMENT_ORIGIN) session.current?.receive(event.nativeEvent.data);
    }}
    onError={() => fail("The native stats document could not load. Retry to open a fresh view.")}
    onHttpError={() => fail("The native stats document could not load. Retry to open a fresh view.")}
    onContentProcessDidTerminate={() => fail("The native stats viewer stopped. Retry to open a fresh view.")}
    onRenderProcessGone={() => fail("The native stats viewer stopped. Retry to open a fresh view.")}
  />;
}
