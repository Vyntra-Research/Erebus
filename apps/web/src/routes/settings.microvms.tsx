import { createFileRoute } from "@tanstack/react-router";

import { MicroVmSettings } from "../components/settings/MicroVmSettings";

function SettingsMicroVmsRoute() {
  return <MicroVmSettings />;
}

export const Route = createFileRoute("/settings/microvms")({
  component: SettingsMicroVmsRoute,
});
