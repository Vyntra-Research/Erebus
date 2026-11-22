import { createFileRoute } from "@tanstack/react-router";

import { ModulesSettings } from "../components/settings/ModulesSettings";

function SettingsModulesRoute() {
  return <ModulesSettings />;
}

export const Route = createFileRoute("/settings/modules")({
  component: SettingsModulesRoute,
});
