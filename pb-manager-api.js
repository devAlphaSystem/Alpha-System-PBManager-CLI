#!/usr/bin/env node

const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs-extra");
const path = require("node:path");
const chalk = require("chalk");
const os = require("node:os");
const util = require("node:util");
const { execFile } = require("node:child_process");
const { z } = require("zod");
const rateLimit = require("express-rate-limit");

const dotenv = require("dotenv");
dotenv.config({ path: path.join(__dirname, ".env") });

const promisifiedExecFile = util.promisify(execFile);

const API_PORT = process.env.API_PORT || 3001;
const EXTERNAL_API_TOKEN = process.env.EXTERNAL_API_TOKEN;
const INTERNAL_CLI_SECRET = process.env.INTERNAL_CLI_SECRET;
const PB_MANAGER_SCRIPT_PATH = path.join(__dirname, "pb-manager.js");

const PB_ACTIONS = {
  LIST_INSTANCES: "listInstances",
  ADD_INSTANCE: "addInstance",
  REMOVE_INSTANCE: "removeInstance",
  GET_GLOBAL_STATS: "getGlobalStats",
  GET_INSTANCE_LOGS: "getInstanceLogs",
  CLONE_INSTANCE: "cloneInstance",
  RESET_INSTANCE: "resetInstance",
  RESET_ADMIN_PASSWORD: "resetAdminPassword",
  RENEW_CERTIFICATES: "renewCertificates",
  UPDATE_POCKETBASE_EXECUTABLE: "updatePocketBaseExecutable",
  UPDATE_ECOSYSTEM_AND_RELOAD_PM2: "updateEcosystemAndReloadPm2",
  SET_DEFAULT_CERTBOT_EMAIL: "setDefaultCertbotEmail",
  START_INSTANCE: "start",
  STOP_INSTANCE: "stop",
  RESTART_INSTANCE: "restart",
  LIST_WITH_JSON: "list",
  INTERNAL_API_REQUEST: "_internal-api-request",
};

const instanceNameSchema = z.string().regex(/^[a-zA-Z0-9-]+$/);

const addInstancePayloadSchema = z.object({
  name: instanceNameSchema,
  domain: z.string().min(1),
  port: z.number().int().min(1025).max(65534),
  useHttps: z.boolean().optional().default(true),
  emailForCertbot: z.string().email().optional().nullable(),
  useHttp2: z.boolean().optional().default(true),
  maxBody20Mb: z.boolean().optional().default(true),
  autoRunCertbot: z.boolean().optional().default(true),
  pocketBaseVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .optional()
    .nullable(),
});

const cloneInstancePayloadSchema = addInstancePayloadSchema.extend({
  sourceName: instanceNameSchema,
  createAdminCli: z.boolean().optional(),
  adminEmail: z.string().email().optional(),
  adminPassword: z.string().min(8).optional(),
});

const resetInstancePayloadSchema = z.object({
  name: instanceNameSchema,
  createAdmin: z.boolean().optional(),
  adminEmail: z.string().email().optional(),
  adminPassword: z.string().min(8).optional(),
});

const resetAdminPasswordPayloadSchema = z.object({
  name: instanceNameSchema,
  adminEmail: z.string().email(),
  adminPassword: z.string().min(8),
});

const renewCertificatesPayloadSchema = z.object({
  instanceName: instanceNameSchema.nullable().optional(),
  force: z.boolean().optional(),
});

const setDefaultCertbotEmailPayloadSchema = z.object({
  email: z.string().email().nullable().optional(),
});

if (!EXTERNAL_API_TOKEN) {
  console.error(chalk.red("EXTERNAL_API_TOKEN environment variable is not set. API server cannot start."));
  process.exit(1);
}

if (!INTERNAL_CLI_SECRET) {
  console.warn(chalk.yellow("INTERNAL_CLI_SECRET environment variable is not set. API will rely on pb-manager.js internal config for its secret, which might lead to issues if not aligned or if API runs as different user."));
}

if (!fs.existsSync(PB_MANAGER_SCRIPT_PATH)) {
  console.error(chalk.red(`pb-manager.js not found at ${PB_MANAGER_SCRIPT_PATH}. Make sure it's in the same directory as pb-manager-api.js.`));
  process.exit(1);
}

const app = express();
app.use(bodyParser.json());

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});
app.use("/api/", apiLimiter);

app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: Missing or malformed Bearer token" });
  }
  const token = authHeader.split(" ")[1];
  if (token !== EXTERNAL_API_TOKEN) {
    return res.status(403).json({ error: "Forbidden: Invalid API token" });
  }
  next();
});

async function executePbManagerCommand(action, argsArray = [], options = {}) {
  const { isJsonOutput = false, useInternal = true, payload = null } = options;

  let pbManagerArgs = [];
  let effectiveJsonOutput = isJsonOutput;
  const actionForLog = action;

  if (useInternal && INTERNAL_CLI_SECRET) {
    pbManagerArgs.push(PB_ACTIONS.INTERNAL_API_REQUEST);
    pbManagerArgs.push("--secret", INTERNAL_CLI_SECRET);
    pbManagerArgs.push("--action", action);
    if (payload) {
      const payloadString = Buffer.from(JSON.stringify(payload)).toString("base64");
      pbManagerArgs.push("--payload", payloadString);
    }
    effectiveJsonOutput = true;
  } else if (useInternal && !INTERNAL_CLI_SECRET) {
    console.warn(chalk.yellow(`Attempting internal call for action '${action}' but INTERNAL_CLI_SECRET is not set in API's .env. Falling back to direct command if applicable, or this may fail if action requires internal call.`));
    pbManagerArgs.push(action);
    pbManagerArgs.push(...argsArray);
  } else {
    pbManagerArgs.push(action);
    pbManagerArgs.push(...argsArray);
  }

  const commandDisplayArgs = [...pbManagerArgs];
  if (INTERNAL_CLI_SECRET) {
    const secretIndex = commandDisplayArgs.indexOf(INTERNAL_CLI_SECRET);
    if (secretIndex > -1) {
      commandDisplayArgs[secretIndex] = "********";
    }
  }

  console.log(chalk.blue(`API executing (Action: ${actionForLog}): sudo node ${PB_MANAGER_SCRIPT_PATH} ${commandDisplayArgs.join(" ")}`));

  try {
    const { stdout, stderr } = await promisifiedExecFile("sudo", ["node", PB_MANAGER_SCRIPT_PATH, ...pbManagerArgs]);

    if (stderr && !effectiveJsonOutput && !stderr.toLowerCase().includes("deprecationwarning")) {
      console.warn(chalk.yellow(`Stderr from command (Action: ${actionForLog}): ${stderr.substring(0, 300)}...`));
    }

    if (effectiveJsonOutput) {
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.success === false) {
          console.error(chalk.yellow(`Internal pb-manager command reported failure. Action: ${actionForLog}. Error: ${parsed.error || JSON.stringify(parsed)}. Full stdout: ${stdout}`));
          return { success: false, error: parsed.error || "Internal command failed", details: parsed.messages || parsed, rawStdout: stdout };
        }
        return { success: true, data: parsed.data !== undefined ? parsed.data : parsed, messages: parsed.messages };
      } catch (e) {
        console.error(chalk.red(`API command JSON parse error. Action: ${actionForLog}. Error: ${e.message}\nRaw Stdout from pb-manager.js: >>>${stdout}<<<`));
        return { success: false, error: "Failed to parse JSON output from command", stdout: stdout, rawStdout: stdout };
      }
    }
    return { success: true, data: stdout.trim(), messages: [] };
  } catch (error) {
    console.error(chalk.red(`API command failed (Action: ${actionForLog}). Code: ${error.code}. Command: sudo node ${PB_MANAGER_SCRIPT_PATH} ${commandDisplayArgs.join(" ")}\nStderr: ${error.stderr}\nStdout: ${error.stdout}`));
    return { success: false, error: `Command failed with code ${error.code}`, stderr: error.stderr, stdout: error.stdout };
  }
}

app.get("/api/v1/instances", async (req, res) => {
  const result = await executePbManagerCommand(PB_ACTIONS.LIST_INSTANCES, [], { isJsonOutput: true, useInternal: true });
  if (result.success) {
    res.json(result.data);
  } else {
    console.log(chalk.yellow("Internal listInstances failed or not configured, falling back to 'list --json'"));
    const fallbackResult = await executePbManagerCommand(PB_ACTIONS.LIST_WITH_JSON, ["--json"], { isJsonOutput: true, useInternal: false });
    if (fallbackResult.success) {
      try {
        res.json(JSON.parse(fallbackResult.data));
      } catch (parseError) {
        res.status(500).json({ error: "Failed to parse fallback list output", details: fallbackResult.data });
      }
    } else {
      res.status(500).json({ error: fallbackResult.error, details: fallbackResult.stderr || fallbackResult.stdout });
    }
  }
});

async function handleInstanceAction(req, res, actionCommand) {
  try {
    const { name } = instanceNameSchema.parse(req.params.name);
    const result = await executePbManagerCommand(actionCommand, [name], { useInternal: false });
    if (result.success) {
      res.json({ success: true, message: `Instance ${name} ${actionCommand} command issued.`, output: result.data });
    } else {
      res.status(500).json({ success: false, error: `Failed to ${actionCommand} instance ${name}`, details: result.stderr || result.stdout });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid instance name format.", details: error.errors });
    }
    res.status(500).json({ error: "Server error during instance action." });
  }
}

app.post("/api/v1/instances/:name/start", (req, res) => {
  handleInstanceAction(req, res, PB_ACTIONS.START_INSTANCE);
});

app.post("/api/v1/instances/:name/stop", (req, res) => {
  handleInstanceAction(req, res, PB_ACTIONS.STOP_INSTANCE);
});

app.post("/api/v1/instances/:name/restart", (req, res) => {
  handleInstanceAction(req, res, PB_ACTIONS.RESTART_INSTANCE);
});

app.post("/api/v1/instances", async (req, res) => {
  try {
    const instanceDetails = addInstancePayloadSchema.parse(req.body);
    const result = await executePbManagerCommand(PB_ACTIONS.ADD_INSTANCE, [], { isJsonOutput: true, useInternal: true, payload: instanceDetails });
    if (result.success) {
      res.status(201).json(result);
    } else {
      res.status(400).json({ error: result.error || "Failed to add instance", details: result.details || result.stderr, messages: result.messages, rawStdout: result.rawStdout });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid payload for adding instance.", details: error.errors });
    }
    console.error(chalk.red(`API POST /instances error: ${error.message}`));
    res.status(500).json({ error: "Server error while adding instance." });
  }
});

app.delete("/api/v1/instances/:name", async (req, res) => {
  try {
    const { name } = instanceNameSchema.parse(req.params.name);
    const { deleteData } = z.object({ deleteData: z.boolean().optional().default(false) }).parse(req.body || {});
    const result = await executePbManagerCommand(PB_ACTIONS.REMOVE_INSTANCE, [], { isJsonOutput: true, useInternal: true, payload: { name, deleteData } });
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json({ error: result.error || `Failed to remove instance ${name}`, details: result.details || result.stderr, messages: result.messages, rawStdout: result.rawStdout });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid instance name or payload format.", details: error.errors });
    }
    console.error(chalk.red(`API DELETE /instances/:name error: ${error.message}`));
    res.status(500).json({ error: "Server error while removing instance." });
  }
});

app.get("/api/v1/system/global-stats", async (req, res) => {
  const result = await executePbManagerCommand(PB_ACTIONS.GET_GLOBAL_STATS, [], { isJsonOutput: true, useInternal: true });
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(500).json({ error: result.error || "Failed to get global stats", details: result.details || result.stderr, messages: result.messages, rawStdout: result.rawStdout });
  }
});

app.get("/api/v1/instances/:name/logs", async (req, res) => {
  try {
    const { name } = instanceNameSchema.parse(req.params.name);
    const { lines } = z.object({ lines: z.coerce.number().int().min(1).max(5000).optional().default(100) }).parse(req.query);

    const result = await executePbManagerCommand(PB_ACTIONS.GET_INSTANCE_LOGS, [], { isJsonOutput: true, useInternal: true, payload: { name, lines } });
    if (result.success) {
      res.json(result);
    } else {
      const statusCode = result.error?.includes("not found") ? 404 : 500;
      res.status(statusCode).json({ error: result.error || `Failed to get logs for instance ${name}`, details: result.details || result.stderr, messages: result.messages, rawStdout: result.rawStdout });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid instance name or query parameters.", details: error.errors });
    }
    console.error(chalk.red(`API GET /instances/:name/logs error: ${error.message}`));
    res.status(500).json({ error: "Server error while getting instance logs." });
  }
});

app.post("/api/v1/instances/clone", async (req, res) => {
  try {
    const cloneDetails = cloneInstancePayloadSchema.parse(req.body);
    const result = await executePbManagerCommand(PB_ACTIONS.CLONE_INSTANCE, [], { isJsonOutput: true, useInternal: true, payload: cloneDetails });
    if (result.success) {
      res.status(201).json(result);
    } else {
      res.status(400).json({ error: result.error || "Failed to clone instance", details: result.details || result.stderr, messages: result.messages, rawStdout: result.rawStdout });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid payload for cloning instance.", details: error.errors });
    }
    console.error(chalk.red(`API POST /instances/clone error: ${error.message}`));
    res.status(500).json({ error: "Server error while cloning instance." });
  }
});

app.post("/api/v1/instances/:name/reset", async (req, res) => {
  try {
    const nameParam = instanceNameSchema.parse(req.params.name);
    const resetDetails = resetInstancePayloadSchema.omit({ name: true }).parse(req.body || {});
    const payload = { name: nameParam, ...resetDetails };
    const result = await executePbManagerCommand(PB_ACTIONS.RESET_INSTANCE, [], { isJsonOutput: true, useInternal: true, payload });
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json({ error: result.error || `Failed to reset instance ${payload.name}`, details: result.details || result.stderr, messages: result.messages, rawStdout: result.rawStdout });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid instance name or payload for reset.", details: error.errors });
    }
    console.error(chalk.red(`API POST /instances/:name/reset error: ${error.message}`));
    res.status(500).json({ error: "Server error while resetting instance." });
  }
});

app.post("/api/v1/instances/:name/reset-admin", async (req, res) => {
  try {
    const nameParam = instanceNameSchema.parse(req.params.name);
    const { adminEmail, adminPassword } = resetAdminPasswordPayloadSchema.omit({ name: true }).parse(req.body);
    const payload = { name: nameParam, adminEmail, adminPassword };
    const result = await executePbManagerCommand(PB_ACTIONS.RESET_ADMIN_PASSWORD, [], { isJsonOutput: true, useInternal: true, payload });
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json({ error: result.error || `Failed to reset admin password for instance ${payload.name}`, details: result.details || result.stderr, messages: result.messages, rawStdout: result.rawStdout });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid instance name or payload for admin reset.", details: error.errors });
    }
    console.error(chalk.red(`API POST /instances/:name/reset-admin error: ${error.message}`));
    res.status(500).json({ error: "Server error while resetting admin password." });
  }
});

app.post("/api/v1/certificates/renew", async (req, res) => {
  try {
    const payload = renewCertificatesPayloadSchema.parse(req.body);
    const result = await executePbManagerCommand(PB_ACTIONS.RENEW_CERTIFICATES, [], { isJsonOutput: true, useInternal: true, payload });
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json({ error: result.error || "Failed to renew certificates", details: result.details || result.stderr, messages: result.messages, rawStdout: result.rawStdout });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid payload for certificate renewal.", details: error.errors });
    }
    console.error(chalk.red(`API POST /certificates/renew error: ${error.message}`));
    res.status(500).json({ error: "Server error while renewing certificates." });
  }
});

app.post("/api/v1/pocketbase/update-executable", async (req, res) => {
  const result = await executePbManagerCommand(PB_ACTIONS.UPDATE_POCKETBASE_EXECUTABLE, [], { isJsonOutput: true, useInternal: true });
  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json({ error: result.error || "Failed to update PocketBase executable", details: result.details || result.stderr, messages: result.messages, rawStdout: result.rawStdout });
  }
});

app.post("/api/v1/system/update-ecosystem", async (req, res) => {
  const result = await executePbManagerCommand(PB_ACTIONS.UPDATE_ECOSYSTEM_AND_RELOAD_PM2, [], { isJsonOutput: true, useInternal: true });
  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json({ error: result.error || "Failed to update ecosystem and reload PM2", details: result.details || result.stderr, messages: result.messages, rawStdout: result.rawStdout });
  }
});

app.post("/api/v1/cli-config/default-certbot-email", async (req, res) => {
  try {
    const payload = setDefaultCertbotEmailPayloadSchema.parse(req.body);
    const result = await executePbManagerCommand(PB_ACTIONS.SET_DEFAULT_CERTBOT_EMAIL, [], { isJsonOutput: true, useInternal: true, payload });
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json({ error: result.error || "Failed to set default Certbot email", details: result.details || result.stderr, messages: result.messages, rawStdout: result.rawStdout });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid payload for setting Certbot email.", details: error.errors });
    }
    console.error(chalk.red(`API POST /cli-config/default-certbot-email error: ${error.message}`));
    res.status(500).json({ error: "Server error while setting default Certbot email." });
  }
});

app.get("/api/v1/system/status", (req, res) => {
  try {
    const cpus = os.cpus();
    const cpuInfo = [];
    for (const cpu of cpus) {
      cpuInfo.push({ model: cpu.model, speed: cpu.speed });
    }
    const status = {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      uptime: os.uptime(),
      arch: os.arch(),
      cpuCount: cpus.length,
      cpuInfo: cpuInfo.length > 0 ? cpuInfo[0] : { model: "N/A", speed: 0 },
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      loadAverage: os.loadavg(),
      timestamp: new Date().toISOString(),
    };
    res.json({ success: true, data: status });
  } catch (error) {
    console.error(chalk.red(`API GET /system/status error: ${error.message}`));
    res.status(500).json({ success: false, error: "Failed to retrieve system status", details: error.message });
  }
});

app.use((err, req, res, next) => {
  console.error(chalk.red(`API Unhandled Error: ${err.stack || err.message}`));
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: "Invalid request payload or parameters.", details: err.errors });
  }
  res.status(500).json({ error: "Internal Server Error" });
});

async function startApiServer() {
  app.listen(API_PORT, () => {
    console.log(chalk.green(`pb-manager API server started on http://localhost:${API_PORT}`));
    console.log(chalk.yellow("Ensure this server is secured if exposed externally and the user running it has appropriate (passwordless) sudo access for pb-manager.js commands."));
    if (EXTERNAL_API_TOKEN) {
      console.log(chalk.cyan(`Using EXTERNAL API Token: ${EXTERNAL_API_TOKEN.substring(0, Math.min(4, EXTERNAL_API_TOKEN.length))}... (masked)`));
    }
    if (INTERNAL_CLI_SECRET) {
      console.log(chalk.cyan(`Using INTERNAL CLI Secret from .env: ${INTERNAL_CLI_SECRET.substring(0, Math.min(4, INTERNAL_CLI_SECRET.length))}... (masked)`));
    } else {
      console.warn(chalk.yellow("INTERNAL_CLI_SECRET is not set in the API's .env file. Internal calls to pb-manager.js might use CLI's stored secret or fail if misaligned."));
    }
  });
}

startApiServer();
