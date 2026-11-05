import { LegendList } from "@legendapp/list/react";
import type { NeoPiModelsConfiguration, NeoPiNativeModel } from "@t3tools/contracts";
import { CheckIcon, ZapIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow } from "../settings/settingsLayout";
import {
  modelContextLabel,
  modelDisplayName,
  modelEffortLabel,
  modelPriceLabel,
  modelRoleForScope,
  modelSelector,
  modelsIndex,
} from "./modelsPresentation";

type Role = NeoPiModelsConfiguration["roles"][number];
type Scope = "global" | "project";

const ROW_HEIGHT = 44;
const COLUMNS = "grid-cols-[minmax(16rem,1fr)_6rem_8rem_9rem]";
const CELL = "px-2";
/** The catalog can hold thousands of rows; the viewport shows a screenful and the page keeps its own scroll. */
const viewportHeight = (rows: number) =>
  `min(${rows * ROW_HEIGHT}px, max(20rem, calc(100dvh - 18rem)))`;

const number = (value: number | null) => value?.toLocaleString() ?? "Not reported";

function ModelRow({
  model,
  rowIndex,
  catalog,
  roles,
  scope,
  pending,
  assign,
  setThreadModel,
  showDetails,
}: {
  model: NeoPiNativeModel;
  rowIndex: number;
  catalog: ReadonlyArray<NeoPiNativeModel>;
  roles: ReadonlyArray<Role>;
  scope: Scope;
  pending: boolean;
  assign: (role: Role, selector: string) => Promise<boolean>;
  setThreadModel: ((model: NeoPiNativeModel) => Promise<void>) | undefined;
  showDetails: (model: NeoPiNativeModel) => void;
}) {
  const [open, setOpen] = useState(false);
  const selector = modelSelector(model);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        nativeButton={false}
        render={
          <div
            role="row"
            aria-rowindex={rowIndex + 2}
            tabIndex={0}
            className={`grid ${COLUMNS} cursor-pointer items-center border-b text-xs transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50`}
            style={{ height: ROW_HEIGHT }}
            onContextMenu={(event) => {
              event.preventDefault();
              setOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                setOpen(true);
              }
            }}
          />
        }
      >
        <div role="cell" className={`${CELL} min-w-0`}>
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium">{modelDisplayName(model)}</span>
            {model.supportsFastMode ? (
              <Tooltip>
                <TooltipTrigger render={<span />}>
                  <ZapIcon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup>Fast mode available</TooltipPopup>
              </Tooltip>
            ) : null}
            {model.kind !== "chat" ? (
              <Badge size="sm" variant="outline">
                {model.kind}
              </Badge>
            ) : null}
          </div>
          <div className="truncate font-mono text-xs text-muted-foreground">{model.id}</div>
        </div>
        <div role="cell" className={`${CELL} text-right`}>
          <Tooltip>
            <TooltipTrigger render={<span className="tabular-nums" />}>
              {modelContextLabel(model.contextWindow)}
            </TooltipTrigger>
            <TooltipPopup>
              {number(model.effectiveContextWindow)} usable · {number(model.contextWindow)} window ·{" "}
              {number(model.maxTokens)} max output
            </TooltipPopup>
          </Tooltip>
        </div>
        <div role="cell" className={`${CELL} text-right`}>
          <span className="tabular-nums">
            {model.cost.input === 0 && model.cost.output === 0 ? (
              <Tooltip>
                <TooltipTrigger render={<span />}>—</TooltipTrigger>
                <TooltipPopup>No per-token price reported</TooltipPopup>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger render={<span />}>{modelPriceLabel(model.cost)}</TooltipTrigger>
                <TooltipPopup>
                  {`$${model.cost.input} input / $${model.cost.output} output`}
                </TooltipPopup>
              </Tooltip>
            )}
          </span>
        </div>
        <div role="cell" className={`${CELL} whitespace-nowrap`}>
          {modelEffortLabel(model.permittedEfforts)}
        </div>
      </MenuTrigger>
      <MenuPopup align="start">
        {/* Keep role/catalog resolution out of every closed row. */}
        {open ? (
          <MenuSub>
            <MenuSubTrigger>Assign to role</MenuSubTrigger>
            <MenuSubPopup>
              {roles.map((role) => {
                const resolution = role.scopedResolutions[scope];
                const using =
                  resolution?.provider === model.provider && resolution.modelId === model.id;
                const currentModel = resolution
                  ? modelsIndex(catalog).bySelector.get(
                      `${resolution.provider}/${resolution.modelId}`,
                    )
                  : undefined;
                const current = currentModel ? modelDisplayName(currentModel) : resolution?.modelId;
                return (
                  <MenuItem
                    key={role.id}
                    disabled={pending}
                    onClick={() => {
                      void assign(role, selector);
                    }}
                  >
                    {using ? <CheckIcon className="size-3" /> : null}
                    <span>{role.id}</span>
                    <span className="ml-auto max-w-48 truncate text-xs text-muted-foreground">
                      {current ??
                        (modelRoleForScope(role, scope).selector ? "Not available" : "Automatic")}
                    </span>
                  </MenuItem>
                );
              })}
            </MenuSubPopup>
          </MenuSub>
        ) : null}
        {setThreadModel ? (
          <MenuItem
            onClick={() => {
              void setThreadModel(model);
            }}
          >
            Use in this thread
          </MenuItem>
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={() => showDetails(model)}>Details…</MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function ModelDetails({
  model,
  open,
  onOpenChange,
}: {
  model: NeoPiNativeModel | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        {model ? (
          <>
            <DialogHeader>
              <DialogTitle>{modelDisplayName(model)}</DialogTitle>
              <DialogDescription>{model.description ?? model.name ?? model.id}</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <SettingsRow title="ID" description={modelSelector(model)} />
              <SettingsRow
                title="Context"
                description={`${number(model.effectiveContextWindow)} usable · ${number(model.contextWindow)} window · ${number(model.maxTokens)} max output`}
              />
              <SettingsRow
                title="Price per million tokens"
                description={`$${model.cost.input} input / $${model.cost.output} output · $${model.cost.cacheRead} cache read / $${model.cost.cacheWrite} cache write`}
              />
              <SettingsRow
                title="Efforts"
                description={model.permittedEfforts.join(", ") || "No controllable effort"}
              />
            </DialogPanel>
          </>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * The catalog as a windowed table: only the rows near the viewport are mounted, so opening All
 * models or typing in its filter costs a screenful of rows rather than thousands.
 */
export function ModelsCatalogTable({
  models,
  catalog,
  roles,
  scope,
  pending,
  assign,
  setThreadModel,
  label,
  query,
}: {
  models: ReadonlyArray<NeoPiNativeModel>;
  /** The whole catalog snapshot, for resolving a role's current model. */
  catalog: ReadonlyArray<NeoPiNativeModel>;
  roles: ReadonlyArray<Role>;
  scope: Scope;
  pending: boolean;
  assign: (role: Role, selector: string) => Promise<boolean>;
  setThreadModel: ((model: NeoPiNativeModel) => Promise<void>) | undefined;
  label: string;
  query: string;
}) {
  const [details, setDetails] = useState<NeoPiNativeModel | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const showDetails = useCallback((model: NeoPiNativeModel) => {
    setDetails(model);
    setDetailsOpen(true);
  }, []);
  const extraData = useMemo(
    () => ({ catalog, roles, scope, pending, assign, setThreadModel }),
    [catalog, roles, scope, pending, assign, setThreadModel],
  );
  return (
    <div
      className="overflow-x-auto"
      role="table"
      aria-label={label}
      aria-rowcount={models.length + 1}
    >
      <div className="min-w-[38rem]">
        <div role="rowgroup">
          <div
            role="row"
            aria-rowindex={1}
            className={`grid ${COLUMNS} h-10 items-center border-b text-xs font-medium text-foreground`}
          >
            <div role="columnheader" className={CELL}>
              Model
            </div>
            <div role="columnheader" className={`${CELL} text-right`}>
              Context
            </div>
            <div role="columnheader" className={`${CELL} text-right`}>
              <Tooltip>
                <TooltipTrigger render={<span />}>Price</TooltipTrigger>
                <TooltipPopup>Per million input / output tokens</TooltipPopup>
              </Tooltip>
            </div>
            <div role="columnheader" className={CELL}>
              Effort
            </div>
          </div>
        </div>
        {models.length === 0 ? (
          <div role="row">
            <div role="cell" className="p-2 text-xs">
              No models match “{query}”.
            </div>
          </div>
        ) : (
          <div role="rowgroup">
            <LegendList
              data={models}
              extraData={extraData}
              keyExtractor={modelSelector}
              estimatedItemSize={ROW_HEIGHT}
              drawDistance={ROW_HEIGHT * 8}
              recycleItems={false}
              maintainVisibleContentPosition={false}
              style={{ height: viewportHeight(models.length) }}
              renderItem={({ item, index }) => (
                <ModelRow
                  model={item}
                  rowIndex={index}
                  catalog={catalog}
                  roles={roles}
                  scope={scope}
                  pending={pending}
                  assign={assign}
                  setThreadModel={setThreadModel}
                  showDetails={showDetails}
                />
              )}
            />
          </div>
        )}
      </div>
      <ModelDetails model={details} open={detailsOpen} onOpenChange={setDetailsOpen} />
    </div>
  );
}
