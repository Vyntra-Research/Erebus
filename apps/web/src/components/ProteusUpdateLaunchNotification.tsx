import { useNavigate } from "@tanstack/react-router";
import { DownloadIcon } from "lucide-react";
import { useEffect } from "react";

import { usePrimaryEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { stackedThreadToast, toastManager } from "./ui/toast";

const seenProteusUpdateNotifications = new Set<string>();

export function ProteusUpdateLaunchNotification() {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const { data: status } = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.proteusStatus({ environmentId, input: {} }),
  );

  useEffect(() => {
    if (!status?.updateAvailable || !status.latestVersion) return;
    const key = `${environmentId ?? "primary"}:${status.version}:${status.latestVersion}`;
    if (seenProteusUpdateNotifications.has(key)) return;
    seenProteusUpdateNotifications.add(key);
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: `Proteus ${status.latestVersion} is available`,
        description: `Erebus is using Proteus ${status.version}.`,
        timeout: 0,
        actionProps: {
          children: "View",
          onClick: () => void navigate({ to: "/settings/general" }),
        },
        actionVariant: "outline",
        data: {
          hideCopyButton: true,
          leadingIcon: <DownloadIcon aria-hidden="true" className="size-4 text-success" />,
        },
      }),
    );
  }, [environmentId, navigate, status]);

  return null;
}
