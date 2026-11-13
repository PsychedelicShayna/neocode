import { ProviderDriverKind } from "@t3tools/contracts";
import type { NativeChatComposerProps } from "../chat/ChatComposer";
import { shouldRenderTraitsControls, TraitsPicker } from "../chat/TraitsPicker";
import { cn } from "~/lib/utils";

const nativeProvider = ProviderDriverKind.make("neopi");

type Props = Pick<NativeChatComposerProps["nativeSession"], "modelControl" | "traits"> & {
  hidden: boolean;
  collapsed: boolean;
  hiddenBlockCount: number;
  iconOnlyBlockCount: number;
};

export function NativeComposerControls({
  modelControl,
  traits,
  hidden,
  collapsed,
  hiddenBlockCount,
  iconOnlyBlockCount,
}: Props) {
  const hasTraits =
    traits !== null && shouldRenderTraitsControls({ provider: nativeProvider, ...traits });
  const overflow = hiddenBlockCount > 0;
  const iconOnly = iconOnlyBlockCount > 0;
  const size = collapsed ? "xs" : "sm";

  return (
    <>
      {modelControl}
      {hasTraits && traits ? (
        <>
          <div
            data-resting-block="traits"
            data-composer-block-icon-only={iconOnly ? "true" : "false"}
            aria-hidden={overflow || undefined}
            inert={overflow || undefined}
            className={cn(
              "flex w-max min-w-max shrink-0 items-center gap-1",
              overflow && "pointer-events-none invisible absolute",
              iconOnly &&
                "[&_[data-composer-control-label]]:pointer-events-none [&_[data-composer-control-label]]:invisible [&_[data-composer-control-label]]:absolute [&_[data-composer-control-label]]:w-max [&_[data-composer-control-label]]:max-w-none",
            )}
          >
            <TraitsPicker
              provider={nativeProvider}
              {...traits}
              size={size}
              hidden={hidden || overflow}
              isComposerOwned
            />
          </div>
          <div
            data-resting-controls-overflow
            aria-hidden={!overflow || undefined}
            inert={!overflow || undefined}
            className={cn(
              "min-w-0 shrink-0",
              !overflow && "pointer-events-none invisible absolute",
            )}
          >
            <TraitsPicker
              provider={nativeProvider}
              {...traits}
              size={size}
              hidden={hidden || !overflow}
              triggerClassName="[&_[data-composer-control-label]]:sr-only"
              isComposerOwned
            />
          </div>
        </>
      ) : null}
    </>
  );
}
