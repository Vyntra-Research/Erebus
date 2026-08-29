import { createFileRoute } from "@tanstack/react-router";

import { ResearchSettings } from "../components/settings/ResearchSettings";

function SettingsResearchRoute() {
  return <ResearchSettings />;
}

export const Route = createFileRoute("/settings/research")({
  component: SettingsResearchRoute,
});
