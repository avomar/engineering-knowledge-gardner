import { cleanupDemoData } from "./feedback-maintenance";
import type { Env } from "./env";
import { app } from "./index";

export default {
  fetch(request: Request, environment: Env, context: ExecutionContext) {
    return app.fetch(request, environment, context);
  },
  scheduled(
    _controller: ScheduledController,
    environment: Env,
    context: ExecutionContext,
  ) {
    context.waitUntil(cleanupDemoData(environment));
  },
};
export { KnowledgeSyncWorkflow } from "./sync-workflow";
