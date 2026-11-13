import { nativeCommandTextRuns } from "@t3tools/client-runtime/neopi-command-output";
import { nativeValueItems } from "@t3tools/client-runtime/neopi-native-sessions";
import { memo, useMemo } from "react";
import { Text as NativeText } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";

export const NativeCommandOutput = memo(function NativeCommandOutput({ text }: { text: string }) {
  const runs = useMemo(() => nativeCommandTextRuns(text), [text]);
  return (
    <Text selectable className="font-mono text-sm text-foreground">
      {nativeValueItems(runs).map(({ value: run, key }) => (
        <NativeText
          key={key}
          style={{ color: run.color ?? undefined, fontWeight: run.bold ? "bold" : "normal" }}
        >
          {run.text}
        </NativeText>
      ))}
    </Text>
  );
});
