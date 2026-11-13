import type { EnvironmentId, NeoPiNativeSessionRef } from "@t3tools/contracts";
import { hostPreviewMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import { useState } from "react";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { useAssetUrlState } from "../../assets/assetUrls";
import { useProjectFileQuery } from "../files/projectFilesQueryState";
import ReadOnlySourcePreview from "../files/ReadOnlySourcePreview";
import { BrowserDocumentFrame } from "../files/BrowserDocumentFrame";
import { Dialog, DialogPopup, DialogHeader, DialogTitle } from "../ui/dialog";
import { Spinner } from "../ui/spinner";

type FileContext = {
  environmentId: EnvironmentId;
  nativeRef: NeoPiNativeSessionRef;
  cwd: string | undefined;
  path: string;
};

function NativeSourceFile({ environmentId, cwd, path }: FileContext) {
  // This existing environment+path read is bounded and read-only; it does not
  // create a SQL thread or grant a client-supplied cwd authority over asset URLs.
  const file = useProjectFileQuery(environmentId, cwd ?? "/", path);
  if (file.error || file.isNotFile)
    return <p role="alert">File unavailable. {file.error ?? "This path is not a file."}</p>;
  if (!file.data) return <Spinner />;
  return (
    <>
      {file.data.truncated ? <p>Partial file: preview reached the read limit.</p> : null}
      <ReadOnlySourcePreview name={path} text={file.data.contents} />
    </>
  );
}

function NativeHostedFile(props: FileContext & { mimeType: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const insideWorkspace = props.cwd
    ? mediaFileReference(resolvePathLinkTarget(props.path, props.cwd), props.cwd).relativePath !==
      undefined
    : false;
  const resource = {
    _tag:
      props.mimeType === "text/html" && insideWorkspace
        ? "native-workspace-file"
        : "native-media-file",
    ref: props.nativeRef,
    path: props.path,
  } as const;
  const asset = useAssetUrlState(props.environmentId, resource);
  if (asset._tag === "Failure" || (asset._tag === "Success" && failedUrl === asset.url))
    return <p role="alert">File unavailable. Reconnect or check that the file still exists.</p>;
  if (asset._tag !== "Success") return <Spinner />;
  if (props.mimeType.startsWith("image/"))
    return (
      <img
        src={asset.url}
        alt={props.path}
        className="max-h-full max-w-full object-contain"
        onError={() => setFailedUrl(asset.url)}
      />
    );
  if (props.mimeType.startsWith("video/"))
    return (
      <video
        src={asset.url}
        controls
        className="max-h-full max-w-full"
        onError={() => setFailedUrl(asset.url)}
      />
    );
  if (props.mimeType.startsWith("audio/"))
    return <audio src={asset.url} controls onError={() => setFailedUrl(asset.url)} />;
  return (
    <BrowserDocumentFrame
      src={asset.url}
      title={props.path}
      pdf={props.mimeType === "application/pdf"}
    />
  );
}

export function NativeMarkdownFilePreview(props: FileContext & { onClose: () => void }) {
  const extension = /\.[^./\\]+$/.exec(props.path)?.[0] ?? "";
  const mimeType = hostPreviewMimeTypeFromExtension(extension);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="flex h-[80vh] min-h-0 flex-col">
        <DialogHeader>
          <DialogTitle>{props.path}</DialogTitle>
        </DialogHeader>
        {mimeType ? (
          <NativeHostedFile {...props} mimeType={mimeType} />
        ) : (
          <NativeSourceFile {...props} />
        )}
      </DialogPopup>
    </Dialog>
  );
}
