// agentglass — Antigravity CLI (~/.gemini/antigravity-cli) adapter
// SPDX-License-Identifier: Apache-2.0
import { statSync } from "node:fs";
import { join, dirname } from "node:path";
import { type Obj, obj, str, arr, parse as parseJson } from "../util/json.ts";
import { HOME, listDir } from "../util/fs.ts";
import { query } from "../util/sqlite.ts";
import type { Ev, Sess } from "../model/types.ts";
import { C } from "../ui/theme.ts";
import { type Acc, bucket, tool, pend, file, lines, tokens, turn, nlines, num, isoMs } from "../features/usage/record.ts";
import { MQ_MSG } from "../features/usage/facts.ts";
import { done } from "../features/usage/calls.ts";
import type { AddFn, HarnessAdapter } from "./types.ts";
import { toolArg, isNoise, prompts } from "./common.ts";

function cleanPrompt(text: string): string {
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(text);
  if (m && m[1]) return m[1].trim();
  return text.trim();
}

function agyToolArg(name: string, args: Obj | null): string {
  if (args) {
    if (args["CommandLine"] !== undefined) return str(args["CommandLine"]);
    if (args["TargetFile"] !== undefined) return str(args["TargetFile"]);
    if (args["AbsolutePath"] !== undefined) return str(args["AbsolutePath"]);
    if (args["query"] !== undefined) return str(args["query"]);
    if (args["Prompt"] !== undefined) return str(args["Prompt"]);
    if (args["Action"] !== undefined) return str(args["Action"]);
    return toolArg(name, args, "");
  }
  return "";
}

function parseUriCwd(raw: string): string {
  if (!raw) return "";
  try {
    const list = JSON.parse(raw);
    if (Array.isArray(list) && list.length > 0 && typeof list[0] === "string") {
      let u = list[0];
      if (u.startsWith("file://")) u = u.slice(7);
      return decodeURIComponent(u);
    }
  } catch (e) {
    // fallback if not JSON
  }
  if (raw.startsWith("file://")) return decodeURIComponent(raw.slice(7));
  return raw;
}

interface MetaRow {
  title: string;
  cwd: string;
  parent: string;
  kind: string;
}

const META = new Map<string, MetaRow>();
let lastDbMtime = -1;

function statSize(p: string): number {
  try { return statSync(p).size; } catch (e) { return -1; }
}

function updateMeta(): void {
  const dbPath = join(HOME, ".gemini", "antigravity-cli", "conversation_summaries.db");
  let mt = -1;
  try { mt = statSync(dbPath).mtimeMs; } catch (e) { return; }
  if (mt <= lastDbMtime) return;
  lastDbMtime = mt;
  const rows = query(dbPath, "SELECT conversation_id, title, workspace_uris, parent_conversation_id, agent_name FROM conversation_summaries");
  if (!rows) return;
  for (const r of rows) {
    const id = str(r["conversation_id"]);
    if (!id) continue;
    const title = str(r["title"]);
    const cwd = parseUriCwd(str(r["workspace_uris"]));
    const parent = str(r["parent_conversation_id"]);
    const kind = str(r["agent_name"]) || (parent ? "subagent" : "");
    META.set(id, { title, cwd, parent, kind });
  }
}

function roots(): string[] {
  const out: string[] = [];
  const appData = process.env["ANTIGRAVITY_APP_DATA_DIR"];
  if (appData) {
    const b = join(appData, "brain");
    if (statSize(b) >= 0) out.push(b);
  }
  const cliBrain = join(HOME, ".gemini", "antigravity-cli", "brain");
  if (statSize(cliBrain) >= 0 && out.indexOf(cliBrain) < 0) out.push(cliBrain);
  const appBrain = join(HOME, ".gemini", "antigravity", "brain");
  if (statSize(appBrain) >= 0 && out.indexOf(appBrain) < 0) out.push(appBrain);
  return out;
}

function scan(add: AddFn): void {
  updateMeta();
  for (const root of roots()) {
    for (const id of listDir(root)) {
      const p = join(root, id, ".system_generated", "logs", "transcript.jsonl");
      if (statSize(p) >= 0) {
        const m = META.get(id);
        const parent = m ? m.parent : "";
        add(p, id, parent, false);
      }
    }
  }
}

function meta(s: Sess): void {
  updateMeta();
  const m = META.get(s.id);
  if (m) {
    if (m.title && !s.title) s.title = m.title;
    if (m.cwd && !s.cwd) s.cwd = m.cwd;
    if (m.parent && !s.parent) {
      s.parent = m.parent;
      s.kind = m.kind || "subagent";
    }
  }
}

const lastCalls = new Map<string, string>();

function parse(o: Obj, out: Ev[], s: Sess | null): void {
  const type = str(o["type"]);
  const ts = str(o["created_at"]);
  const si = num(o["step_index"]);
  const sessKey = s ? s.id : "";

  if (type === "USER_INPUT") {
    const raw = str(o["content"]);
    const text = cleanPrompt(raw);
    if (text && !isNoise(text)) {
      out.push({ kind: "user", text, ts, id: "", full: raw });
      if (s && !s.prompt) s.prompt = text;
      if (s && !s.title) s.title = text;
    }
    return;
  }

  if (type === "PLANNER_RESPONSE") {
    const thinking = str(o["thinking"]);
    if (thinking) {
      out.push({ kind: "thinking", text: thinking, ts, id: "", full: "" });
    }

    const content = str(o["content"]);
    if (content) {
      out.push({ kind: "assistant", text: content, ts, id: "", full: "" });
    }

    const calls = arr(o["tool_calls"]);
    for (let i = 0; i < calls.length; i++) {
      const co = obj(calls[i]);
      if (!co) continue;
      const name = str(co["name"]) || "tool";
      const args = obj(co["args"]);
      const callId = "c" + si + (calls.length > 1 ? "_" + i : "");
      lastCalls.set(sessKey, callId);
      const argStr = agyToolArg(name, args);
      out.push({ kind: "tool", text: name + "\u0000" + argStr, ts, id: callId, full: args ? JSON.stringify(args) : "" });
      if (s && !s.cwd && args && str(args["Cwd"])) {
        s.cwd = str(args["Cwd"]);
      }
    }
    if (s && !s.model) s.model = "gemini-3.8-flash";
    return;
  }

  if (type === "GENERIC") {
    const content = str(o["content"]);
    const status = str(o["status"]);
    const callId = lastCalls.get(sessKey) || ("c" + (si - 1));
    const tag = (status && status !== "DONE" && status !== "success") ? "[" + status + "] " : "";
    out.push({ kind: "result", text: tag + content, ts, id: callId, full: content });
    return;
  }

  if (type === "CHECKPOINT") {
    out.push({ kind: "meta", text: "checkpoint", ts, id: "", full: "" });
    return;
  }
}

function busy(s: Sess): boolean {
  const e = s.evs.length ? s.evs[s.evs.length - 1] : null;
  return !!e && e.kind !== "assistant" && e.kind !== "meta";
}

function usage(a: Acc, l: string): void {
  if (l.indexOf("\"USER_INPUT\"") >= 0) {
    const o = parseJson(l);
    if (o && str(o["type"]) === "USER_INPUT") {
      if (!a.sub) turn(a, 0, str(o["created_at"]), prompts(parse, o));
      return;
    }
  }

  if (l.indexOf("\"PLANNER_RESPONSE\"") >= 0) {
    const o = parseJson(l);
    if (!o || str(o["type"]) !== "PLANNER_RESPONSE") return;
    const iso = str(o["created_at"]);
    const d = bucket(a, 0, iso);
    const md = a.model || "gemini-3.8-flash";
    const inp = num(o["input_tokens"]);
    const out = num(o["output_tokens"]);
    const cached = num(o["cache_read_tokens"]);
    if (inp > 0 || out > 0 || cached > 0) {
      tokens(a, d, md, Math.max(0, inp - cached), out, cached, 0, 0);
    }
    const t0 = isoMs(iso);
    const si = num(o["step_index"]);
    const calls = arr(o["tool_calls"]);
    for (let i = 0; i < calls.length; i++) {
      const co = obj(calls[i]);
      if (!co) continue;
      const name = str(co["name"]) || "tool";
      const args = obj(co["args"]);
      const callId = "c" + si + (calls.length > 1 ? "_" + i : "");
      const st = tool(a, d, name, md, MQ_MSG);
      const cmd = name === "run_command" && args ? [str(args["CommandLine"]) || str(args["command"])] : [];
      pend(a, d, st, name, callId, t0, iso, agyToolArg(name, args), cmd);

      if (!args) continue;
      if (name === "replace_file_content") {
        const fp = str(args["TargetFile"]) || str(args["file_path"]);
        const add = nlines(str(args["ReplacementContent"]));
        const del = nlines(str(args["TargetContent"]));
        lines(a, d, add, del);
        file(a, d, name, fp, add, del);
      } else if (name === "write_to_file") {
        const fp = str(args["TargetFile"]) || str(args["file_path"]);
        const add = nlines(str(args["CodeContent"]));
        lines(a, d, add, 0);
        file(a, d, name, fp, add, 0);
      }
    }
    return;
  }

  if (l.indexOf("\"GENERIC\"") >= 0) {
    const o = parseJson(l);
    if (!o || str(o["type"]) !== "GENERIC") return;
    const si = num(o["step_index"]);
    const callId = "c" + (si - 1);
    let p = a.pend.get(callId);
    if (!p && a.pend.size > 0) {
      p = a.pend.values().next().value;
    }
    if (p) {
      a.pend.delete(p.id);
      const t1 = isoMs(str(o["created_at"]));
      const content = str(o["content"]);
      const status = str(o["status"]);
      const ok = !status || status === "DONE" || status === "success";
      done(p, p.t > 0 && t1 >= p.t ? t1 - p.t : -1, !ok, content.length, p.id, []);
    }
    return;
  }
}

function files(s: Sess): string[] {
  const out: string[] = [s.path];
  const d = dirname(s.path);
  const gen = dirname(d);
  const b = dirname(gen);
  if (statSize(b) >= 0) out.push(b);
  const conv = join(HOME, ".gemini", "antigravity-cli", "conversations", s.id + ".db");
  if (statSize(conv) >= 0) out.push(conv);
  for (const ext of ["-shm", "-wal"]) {
    const f = conv + ext;
    if (statSize(f) >= 0) out.push(f);
  }
  return out;
}

export const antigravity: HarnessAdapter = {
  id: "antigravity",
  label: "AntiG",
  glyph: "⟡",
  mark: "⟡",
  color: () => C.purple,
  bin: "agy",
  procs: ["agy", "antigravity"],
  roots,
  scan,
  meta,
  refresh: meta,
  headBytes: 65536,
  parse,
  busy,
  liveCwd: true,
  headless: (s: Sess, msg: string) => ["--conversation", s.id, "-p", msg],
  resume: (s: Sess) => ["--conversation", s.id],
  files,
  usage,
};
