#!/usr/bin/env node

import { hashPassword } from "../lib/password.js";

if (process.argv.length > 2) {
  console.error("Do not pass a password on the command line. Use the interactive prompt or stdin.");
  process.exit(2);
}

function readTtySecret(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let value = "";
    process.stderr.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          process.stderr.write("\n");
          reject(new Error("Cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    input.on("data", onData);
  });
}

async function readPassword() {
  if (process.stdin.isTTY) {
    const first = await readTtySecret("Administrator password: ");
    const second = await readTtySecret("Confirm password: ");
    if (first !== second) throw new Error("Passwords do not match");
    return first;
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const lines = Buffer.concat(chunks).toString("utf8").replace(/\r/g, "").split("\n").filter(Boolean);
  if (!lines[0]) throw new Error("No password was provided on stdin");
  if (lines[1] !== undefined && lines[0] !== lines[1]) throw new Error("Passwords do not match");
  return lines[0];
}

try {
  console.log(await hashPassword(await readPassword()));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
