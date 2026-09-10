import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Folder } from "lucide-react";
import { type ComponentType, useState } from "react";

const FAVICON_STALE_TIME_MS = 5 * 60_000;

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
