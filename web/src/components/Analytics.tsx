import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getAgentAnalytics,
  getRTP,
  getStatus,
  hangup,
  listTrunks,
  type AgentStat,
  type Channel,
  type RTPStat,
} from "../api";
import type { Notify } from "../types";
import { groupCalls, CallFlow, type AudioFlow } from "./CallFlow";

const RANGES = [
  { label: "Today", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
];

function fmtDur(sec: number): string {
  if (!sec) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function pct(n: number, d: number): string {
  if (!d) return "—";
  return `${Math.round((n / d) * 100)}%`;
}

export default function Analytics({ notify }: { notify: Notify }) {
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<AgentStat[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    getAgentAnalytics(days)
      .then((r) => setRows(r.agents))
      .catch((e) => notify({ kind: "err", text: (e as Error).message }))
      .finally(() => setLoading(false));
  }, [days, notify]);

  useEffect(load, [load]);

  // Team totals across all agents.
  const totals = useMemo(() => {
    return rows.reduce(
      (t, a) => ({
        calls: t.calls + a.calls,
        answered: t.answered + a.answered,
        missed: t.missed + a.missed,
        talkTotal: t.talkTotal + a.talkTotal,
        transfers: t.transfers + a.transfers,
      }),
      { calls: 0, answered: 0, missed: 0, talkTotal: 0, transfers: 0 }
    );
  }, [rows]);

  return (
    <>
      <LiveCalls notify={notify} />

      <div className="page-head">
        <h2>Analytics</h2>
        <div className="range-tabs">
          {RANGES.map((r) => (
            <button
              key={r.days}
              className={`btn ghost small ${days === r.days ? "active" : ""}`}
              onClick={() => setDays(r.days)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="stat-row">
        <StatCard label="Total calls" value={String(totals.calls)} />
        <StatCard
          label="Answered"
          value={String(totals.answered)}
          sub={pct(totals.answered, totals.calls) + " of calls"}
        />
        <StatCard label="Missed" value={String(totals.missed)} />
        <StatCard label="Talk time" value={fmtDur(totals.talkTotal)} />
        <StatCard label="Transfers" value={String(totals.transfers)} />
      </div>

      <section className="panel">
        <header>Per-agent performance</header>
        {loading ? (
          <div className="empty">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="empty">No agents / no calls in this period.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Calls</th>
                  <th>In</th>
                  <th>Out</th>
                  <th>Answered</th>
                  <th>Missed</th>
                  <th>Answer rate</th>
                  <th>Talk total</th>
                  <th>Avg</th>
                  <th>Longest</th>
                  <th>Transfers</th>
                  <th>Hung up (agent / caller)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.extension}>
                    <td>
                      <strong>{a.displayName}</strong>
                      <span style={{ color: "var(--muted)" }}> · {a.extension}</span>
                    </td>
                    <td>{a.calls}</td>
                    <td>{a.inbound}</td>
                    <td>{a.outbound}</td>
                    <td>{a.answered}</td>
                    <td>{a.missed > 0 ? <span className="badge offline">{a.missed}</span> : 0}</td>
                    <td>{pct(a.answered, a.calls)}</td>
                    <td>{fmtDur(a.talkTotal)}</td>
                    <td>{fmtDur(a.talkAvg)}</td>
                    <td>{fmtDur(a.longest)}</td>
                    <td>{a.transfers}</td>
                    <td>
                      {a.hangupByAgent} / {a.hangupByOther}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint-inline" style={{ padding: "0 16px 16px" }}>
          "Missed" counts inbound calls that rang the agent but went unanswered
          (no answer / busy). "Hung up" shows how many calls the agent ended
          first vs. the other party.
        </p>
      </section>
    </>
  );
}

// LiveCalls shows the in-progress calls as originator -> PBX -> destination
// flows, tagged with live RTP direction so one-way audio is obvious.
function LiveCalls({ notify }: { notify: Notify }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [trunks, setTrunks] = useState<Set<string>>(new Set());
  const [audio, setAudio] = useState<Record<string, AudioFlow>>({});
  const prev = useRef<Record<string, RTPStat>>({});

  useEffect(() => {
    listTrunks()
      .then((ts) => setTrunks(new Set(ts.map((t) => t.name))))
      .catch(() => {});
  }, []);

  const poll = useCallback(async () => {
    try {
      const [st, rtp] = await Promise.all([getStatus(), getRTP()]);
      setChannels(st.channels ?? []);
      const a: Record<string, AudioFlow> = {};
      for (const [id, cur] of Object.entries(rtp)) {
        const p = prev.current[id];
        // Delta since last poll -> "flowing now"; first sample uses the total.
        a[id] = {
          known: !!cur.known,
          sending: p ? cur.rx > p.rx : cur.rx > 0,
          receiving: p ? cur.tx > p.tx : cur.tx > 0,
        };
      }
      prev.current = rtp;
      setAudio(a);
    } catch {
      /* ignore transient poll errors */
    }
  }, []);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, [poll]);

  const calls = groupCalls(channels, trunks);
  const onHangup = async (id: string) => {
    try {
      await hangup(id);
      poll();
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    }
  };

  return (
    <section className="panel">
      <header>Live Calls</header>
      {calls.length === 0 ? (
        <div className="empty">No active calls.</div>
      ) : (
        <div className="call-flows">
          {calls.map((c) => (
            <CallFlow key={c.id} call={c} audio={audio} onHangup={() => onHangup(c.hangupId)} />
          ))}
        </div>
      )}
      <p className="hint-inline" style={{ padding: "0 16px 16px" }}>
        A green <strong>▲ voice</strong> tag means that party's audio (RTP) is
        reaching the PBX; <strong>▲ no audio</strong> flags a leg that isn't
        sending — the usual cause of one-way audio. Dots travel in the direction
        audio is flowing.
      </p>
    </section>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}
