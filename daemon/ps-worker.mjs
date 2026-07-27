// Node wrapper for the persistent PowerShell worker. Spawns once, speaks the
// line protocol, auto-respawns if the process dies. All commands single-flight.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "ps-worker.ps1");

export class PsWorker {
  #proc = null;
  #queue = Promise.resolve();
  #pending = null;
  #buf = "";

  async start() {
    if (this.#proc) return;
    this.#proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
    );
    this.#proc.stdout.setEncoding("utf8");
    this.#proc.stdout.on("data", (chunk) => {
      this.#buf += chunk;
      let idx;
      while ((idx = this.#buf.indexOf("\n")) >= 0) {
        const line = this.#buf.slice(0, idx).replace(/\r$/, "");
        this.#buf = this.#buf.slice(idx + 1);
        if (line === "READY") continue;
        if (this.#pending) {
          const { resolve } = this.#pending;
          this.#pending = null;
          resolve(line);
        }
      }
    });
    this.#proc.on("exit", () => {
      this.#proc = null;
      if (this.#pending) {
        const { reject } = this.#pending;
        this.#pending = null;
        reject(new Error("ps-worker died"));
      }
    });
    const pong = await this.cmd("PING");
    if (pong !== "OK PING") throw new Error("ps-worker failed handshake: " + pong);
  }

  // Serialized: one in-flight command at a time; b64-encode string args.
  cmd(name, ...args) {
    this.#queue = this.#queue.then(async () => {
      if (!this.#proc) await this.start();
      return new Promise((resolve, reject) => {
        this.#pending = { resolve, reject };
        const encoded = args.map((a, i) =>
          name === "FOCUS_PASTE" && i === 1 ? a : Buffer.from(String(a), "utf8").toString("base64"),
        );
        this.#proc.stdin.write([name, ...encoded].join(" ") + "\n");
        setTimeout(() => {
          if (this.#pending) {
            this.#pending = null;
            reject(new Error(`ps-worker timeout on ${name}`));
          }
        }, 30000);
      });
    }, async () => {
      // Previous command failed - still run this one on a fresh worker.
      if (!this.#proc) await this.start();
      return new Promise((resolve, reject) => {
        this.#pending = { resolve, reject };
        const encoded = args.map((a, i) =>
          name === "FOCUS_PASTE" && i === 1 ? a : Buffer.from(String(a), "utf8").toString("base64"),
        );
        this.#proc.stdin.write([name, ...encoded].join(" ") + "\n");
        setTimeout(() => {
          if (this.#pending) {
            this.#pending = null;
            reject(new Error(`ps-worker timeout on ${name}`));
          }
        }, 30000);
      });
    });
    return this.#queue;
  }

  stop() {
    try { this.#proc?.stdin.write("EXIT\n"); } catch { /* dying anyway */ }
    try { this.#proc?.kill(); } catch { /* gone */ }
    this.#proc = null;
  }
}
