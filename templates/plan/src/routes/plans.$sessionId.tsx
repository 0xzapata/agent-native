import { createFileRoute } from "@tanstack/react-router";

import { LocalPlanEditor } from "../components/local-plan-editor";

export const Route = createFileRoute("/plans/$sessionId")({
  component: PlanSessionRoute,
});

function PlanSessionRoute() {
  const { sessionId } = Route.useParams();
  return <LocalPlanEditor sessionId={sessionId} />;
}
