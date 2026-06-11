import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  ...parseEnvFile(path.join(projectRoot, ".env.local")),
  ...process.env,
};

const databaseUrl = env.DATABASE_URL ?? env.DATABASE_URL3;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is missing from .env.local.");
}

const uri = new URL(databaseUrl);
const host = uri.hostname;
const port = Number(uri.port || 5432);
const timeoutMs = Number(env.POSTGRES_SSLREQUEST_TIMEOUT_MS ?? 10000);

const result = await sendSslRequest(host, port, timeoutMs);
console.log(JSON.stringify(result, null, 2));

function sendSslRequest(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = net.createConnection({ host, port });

    const finish = (payload) => {
      socket.destroy();
      resolve({
        host,
        port,
        elapsedMs: Math.round(performance.now() - started),
        ...payload,
      });
    };

    socket.setTimeout(timeoutMs);

    socket.on("connect", () => {
      const request = Buffer.alloc(8);
      request.writeInt32BE(8, 0);
      request.writeInt32BE(80877103, 4);
      socket.write(request);
    });

    socket.once("data", (data) => {
      const response = data.subarray(0, 1).toString("utf8");
      if (response !== "S") {
        finish({
          ok: false,
          response,
          message:
            response === "N"
              ? "Postgres SSL request rejected."
              : "Unexpected Postgres SSL request response.",
        });
        return;
      }

      socket.removeAllListeners("timeout");
      socket.removeAllListeners("error");

      const secureSocket = tls.connect({
        socket,
        servername: host,
        rejectUnauthorized: false,
      });

      secureSocket.setTimeout(timeoutMs);

      secureSocket.once("secureConnect", () => {
        finish({
          ok: true,
          response,
          tlsAuthorized: secureSocket.authorized,
          tlsProtocol: secureSocket.getProtocol(),
          message: "Postgres SSL request and TLS handshake succeeded.",
        });
      });

      secureSocket.once("timeout", () => {
        finish({
          ok: false,
          response,
          message: "TLS handshake timed out after Postgres SSL request was accepted.",
        });
      });

      secureSocket.once("error", (error) => {
        finish({
          ok: false,
          response,
          message: error.message,
        });
      });
    });

    socket.once("timeout", () => {
      finish({
        ok: false,
        message: "No response to Postgres SSL request before timeout.",
      });
    });

    socket.once("error", (error) => {
      finish({
        ok: false,
        message: error.message,
      });
    });
  });
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};

  const result = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalIndex = trimmed.indexOf("=");
    if (equalIndex === -1) continue;

    const key = trimmed.slice(0, equalIndex).trim();
    let value = trimmed.slice(equalIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}
