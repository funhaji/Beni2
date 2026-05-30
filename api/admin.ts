import type { VercelRequest, VercelResponse } from "@vercel/node";

import backupHandler from "../lib/api/backup.js";
import restoreHandler from "../lib/api/restore.js";
import healthHandler from "../lib/api/health.js";
import logsHandler from "../lib/api/logs.js";
import reachabilityHandler from "../lib/api/reachability.js";
import findDeadHandler from "../lib/api/find-dead.js";
import panelActionHandler from "../lib/api/panel-action.js";
import migrateHandler from "../lib/api/migrate.js";
import marzbanInstallHandler from "../lib/api/marzban-install.js";
import testApproveHandler from "../lib/api/test-approve.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = req.query.action as string;

  switch (action) {
    case "backup":
      return backupHandler(req, res);
    case "restore":
      return restoreHandler(req, res);
    case "health":
      return healthHandler(req, res);
    case "logs":
      return logsHandler(req, res);
    case "reachability":
      return reachabilityHandler(req, res);
    case "find-dead":
      return findDeadHandler(req, res);
    case "panel-action":
      return panelActionHandler(req, res);
    case "migrate":
      return migrateHandler(req, res);
    case "marzban-install":
      return marzbanInstallHandler(req, res);
    case "test-approve":
      return testApproveHandler(req, res);
    default:
      res.status(404).json({ ok: false, error: "Action not found" });
  }
}
