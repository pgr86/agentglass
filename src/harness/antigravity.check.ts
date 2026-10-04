// agentglass — self-check for the Antigravity adapter: scriptc build src/harness/antigravity.check.ts -o ac && ./ac
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, openSync, writeSync, closeSync, rmSync } from "node:fs";
import { join } from "node:path";
import { newSess, type Ev } from "../model/types.ts";
import { newAcc } from "../features/usage/record.ts";
import { antigravity } from "./antigravity.ts";
import { parseEvents, busy } from "./index.ts";

let bad = 0;
function ok(w: string, c: boolean, g: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + g); } }

const DIR = "/tmp/agentglass-antigravity-check-" + String(process.pid);
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

function write(p: string, s: string): void {
  const fd = openSync(p, "w");
  writeSync(fd, s);
  closeSync(fd);
}

// ── 1. Event parsing: prompt cleaning, thinking, tool calls, and results ──
{
  const s = newSess("antigravity", "test-1", join(DIR, "transcript.jsonl"), false);
  const evs: Ev[] = [];

  const rawUser = JSON.stringify({
    step_index: 0,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    status: "DONE",
    created_at: "2026-10-04T10:00:00.000Z",
    content: "<USER_REQUEST>\nFix the auth issue\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime: 2026-10-04\n</ADDITIONAL_METADATA>",
  });

  const rawPlanner = JSON.stringify({
    step_index: 1,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-10-04T10:00:01.000Z",
    input_tokens: 500,
    output_tokens: 80,
    cache_read_tokens: 100,
    thinking: "I will replace the token logic in auth.ts",
    content: "Updating auth.ts now.",
    tool_calls: [
      {
        name: "replace_file_content",
        args: {
          TargetFile: "/dev/auth.ts",
          TargetContent: "const token = null;",
          ReplacementContent: "const token = createToken();\nvalidate(token);",
        },
      },
    ],
  });

  const rawGeneric = JSON.stringify({
    step_index: 2,
    source: "MODEL",
    type: "GENERIC",
    status: "DONE",
    created_at: "2026-10-04T10:00:02.000Z",
    content: "File successfully updated.",
  });

  parseEvents("antigravity", rawUser, evs, s);
  s.evs = evs;
  ok("user prompt cleaned", s.prompt === "Fix the auth issue", s.prompt);
  ok("title matches prompt", s.title === "Fix the auth issue", s.title);
  ok("busy after user input", busy(s), "not busy");

  parseEvents("antigravity", rawPlanner, evs, s);
  s.evs = evs;
  ok("thinking event", evs.some((e) => e.kind === "thinking" && e.text.includes("auth.ts")), "missing thinking");
  ok("assistant event", evs.some((e) => e.kind === "assistant" && e.text === "Updating auth.ts now."), "missing assistant");
  const toolEv = evs.find((e) => e.kind === "tool");
  ok("tool event found", !!toolEv, "no tool event");
  ok("tool text format", !!toolEv && toolEv.text === "replace_file_content\u0000/dev/auth.ts", toolEv?.text ?? "");
  ok("tool id", toolEv?.id === "c1", toolEv?.id ?? "");

  parseEvents("antigravity", rawGeneric, evs, s);
  s.evs = evs;
  const resEv = evs.find((e) => e.kind === "result");
  ok("result event found", !!resEv, "no result event");
  ok("result id matches tool", resEv?.id === toolEv?.id, `${resEv?.id} ≠ ${toolEv?.id}`);
  ok("result text", resEv?.text === "File successfully updated.", resEv?.text ?? "");
  ok("busy while awaiting assistant response", busy(s), "not busy");

  const rawDone = JSON.stringify({
    step_index: 3,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-10-04T10:00:03.000Z",
    content: "All changes applied.",
  });
  parseEvents("antigravity", rawDone, evs, s);
  s.evs = evs;
  ok("not busy after turn complete", !busy(s), "still busy");
}

// ── 2. Usage calculation: tokens, diff line metrics, and call completion ──
{
  const s = newSess("antigravity", "test-2", join(DIR, "transcript.jsonl"), false);
  const a = newAcc();

  const lines = [
    JSON.stringify({
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: "2026-10-04T10:00:00.000Z",
      content: "Do the edit",
    }),
    JSON.stringify({
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-10-04T10:00:01.000Z",
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_tokens: 200,
      tool_calls: [
        {
          name: "replace_file_content",
          args: {
            TargetFile: "/dev/auth.ts",
            TargetContent: "old\nline\n",
            ReplacementContent: "new\nline\nadded\nmore\n",
          },
        },
      ],
    }),
    JSON.stringify({
      step_index: 2,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      created_at: "2026-10-04T10:00:03.000Z",
      content: "OK",
    }),
  ];

  for (const l of lines) {
    antigravity.usage(a, l);
  }

  let tu = 0;
  for (const d of a.days.values()) tu += d.turns;
  ok("turns counted", tu === 1, String(tu));
  ok("tools counted", a.tools === 1, String(a.tools));
  ok("input tokens (net of cached)", a.inTok === 800, String(a.inTok));
  ok("output tokens", a.outTok === 100, String(a.outTok));
  ok("cache read tokens", a.cr === 200, String(a.cr));
  ok("lines added", a.add === 4, String(a.add));
  ok("lines deleted", a.del === 2, String(a.del));
  ok("no pending calls left", a.pend.size === 0, String(a.pend.size));
}

// ── 3. Tool argument formatting for various Antigravity tools ──
{
  const evs: Ev[] = [];
  const s = newSess("antigravity", "test-tools", join(DIR, "t.jsonl"), false);

  const tools = [
    { name: "run_command", args: { CommandLine: "pnpm test" } },
    { name: "view_file", args: { AbsolutePath: "/dev/file.ts" } },
    { name: "write_to_file", args: { TargetFile: "/dev/new.ts", CodeContent: "export const x = 1;" } },
    { name: "search_web", args: { query: "node experimental strip types" } },
    { name: "schedule", args: { DurationSeconds: 10, Prompt: "reminder" } },
    { name: "manage_task", args: { Action: "status", TaskId: "task-1" } },
  ];

  for (let i = 0; i < tools.length; i++) {
    const l = JSON.stringify({
      step_index: i + 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-10-04T10:00:00.000Z",
      tool_calls: [tools[i]],
    });
    parseEvents("antigravity", l, evs, s);
  }

  ok("run_command arg", evs.some((e) => e.kind === "tool" && e.text === "run_command\u0000pnpm test"), "run_command arg mismatch");
  ok("view_file arg", evs.some((e) => e.kind === "tool" && e.text === "view_file\u0000/dev/file.ts"), "view_file arg mismatch");
  ok("write_to_file arg", evs.some((e) => e.kind === "tool" && e.text === "write_to_file\u0000/dev/new.ts"), "write_to_file arg mismatch");
  ok("search_web arg", evs.some((e) => e.kind === "tool" && e.text === "search_web\u0000node experimental strip types"), "search_web arg mismatch");
  ok("schedule arg", evs.some((e) => e.kind === "tool" && e.text === "schedule\u0000reminder"), "schedule arg mismatch");
  ok("manage_task arg", evs.some((e) => e.kind === "tool" && e.text === "manage_task\u0000status"), "manage_task arg mismatch");
}

rmSync(DIR, { recursive: true, force: true });

console.log(bad ? bad + " failed" : "antigravity: all checks passed");
if (bad) process.exit(1);
