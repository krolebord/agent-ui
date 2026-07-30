import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Folder } from "lucide-react";
import { type ComponentType, useState } from "react";

/**
 * Icons a project shipped, resolved in main and inlined as data URLs. Projects
 * without one fall back to the caller's icon, so a repo with a favicon reads as
 * itself in a list while everything else stays uniform.
 */
const FAVICON_STALE_TIME_MS = 5 * 60_000;

/** Already painted once, so a remount skips the fallback flash. */
const paintedFaviconUrls = new Set<string>();

export function ProjectFavicon({
  projectPath,
  className,
  fallbackIcon,
}: {
  projectPath: string;
  className?: string;
  fallbackIcon?: ComponentType<{ className?: string }>;
}) {
  const { data } = useQuery(
    orpc.projects.getFavicon.queryOptions({
      input: { path: projectPath },
      enabled: projectPath.trim().length > 0,
      staleTime: FAVICON_STALE_TIME_MS,
    }),
  );
  const FallbackIcon = fallbackIcon ?? Folder;
  const dataUrl = data?.dataUrl ?? null;

  if (!dataUrl) {
    return <FaviconFallback className={className} icon={FallbackIcon} />;
  }

  return (
    <FaviconImage
      key={dataUrl}
      dataUrl={dataUrl}
      className={className}
      icon={FallbackIcon}
    />
  );
}

function FaviconFallback({
  className,
  icon: Icon,
}: {
  className: string | undefined;
  icon: ComponentType<{ className?: string }>;
}) {
  return <Icon className={cn("size-3.5 shrink-0", className)} />;
}

/**
 * Keeps the fallback in place until the image has decoded, and drops back to it
 * for good if the icon turns out to be undecodable — a valid `.ico` byte stream
 * is not a promise that this build of Chromium renders it.
 */
function FaviconImage({
  dataUrl,
  className,
  icon: Icon,
}: {
  dataUrl: string;
  className: string | undefined;
  icon: ComponentType<{ className?: string }>;
}) {
  const [status, setStatus] = useState<"pending" | "painted" | "failed">(() =>
    paintedFaviconUrls.has(dataUrl) ? "painted" : "pending",
  );

  return (
    <>
      {status === "painted" ? null : (
        <FaviconFallback className={className} icon={Icon} />
      )}
      {status === "failed" ? null : (
        <img
          src={dataUrl}
          alt=""
          className={cn(
            "size-3.5 shrink-0 rounded-sm object-contain",
            status === "painted" ? undefined : "hidden",
            className,
          )}
          onLoad={() => {
            paintedFaviconUrls.add(dataUrl);
            setStatus("painted");
          }}
          onError={() => setStatus("failed")}
        />
      )}
    </>
  );
}
