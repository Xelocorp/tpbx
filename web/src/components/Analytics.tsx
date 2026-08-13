import { useCallback, useEffect, useRef, useState } from "react";
import {
  getExtensionDetail,
  getExtensionStatus,
  getOverview,
  getReports,
  getRTP,
  getStatus,
  hangup,
  listExtensions,
  listTrunks,
  type Channel,
  type DashSlice,
  type Extension,
  type ExtStatus,
  type ExtensionDetail,
  type LiveExtension,
  type OverviewResponse,
  type ReportsStats,
  type RTPStat,
} from "../api";
import type { Notify } from "../types";
import { groupCalls, CallFlow, type AudioFlow } from "./CallFlow";
import { DeviceIcon } from "./Extensions";

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

type DashView = "overview" | "extensions" | "reports";
const VIEWS: { key: DashView; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "extensions", label: "Extensions" },
  { key: "reports", label: "Reports" },
];

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1).replace(/_/g, " ") : s;
}

export default function Analytics({ notify }: { notify: Notify }) {
  const [days, setDays] = useState(7);
  const [view, setView] = useState<DashView>("overview");

  return (
    <>
      <div className="dash-head">
        <div>
          <h2>Analytics</h2>
          <p className="dash-sub">Real-time call center performance metrics.</p>
        </div>
        <div className="dash-controls">
          <div className="seg-tabs">
            {VIEWS.map((v) => (
              <button key={v.key} className={`seg-tab ${view === v.key ? "on" : ""}`} onClick={() => setView(v.key)}>
                {v.label}
              </button>
            ))}
          </div>
          <div className="range-tabs">
            {RANGES.map((r) => (
              <button key={r.days} className={`btn ghost small ${days === r.days ? "active" : ""}`} onClick={() => setDays(r.days)}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {view === "overview" ? (
        <OverviewView days={days} notify={notify} />
      ) : view === "extensions" ? (
        <ExtensionsView days={days} notify={notify} />
      ) : (
        <ReportsView days={days} notify={notify} />
      )}
    </>
  );
}

// --- Overview ---------------------------------------------------------------

function OverviewView({ days, notify }: { days: number; notify: Notify }) {
  const [data, setData] = useState<OverviewResponse | null>(null);
  useEffect(() => {
    getOverview(days).then(setData).catch((e) => notify({ kind: "err", text: (e as Error).message }));
  }, [days, notify]);
  const o = data?.overview;

  return (
    <>
      <div className="dash-cards">
        <DashCard label="Total Calls" value={o ? o.totalCalls.toLocaleString() : "—"} />
        <DashCard label="Avg. Handle Time" value={o ? fmtDur(o.ahtSeconds) : "—"} />
        <DashCard label="Resolution Rate" value={o ? `${Math.round(o.resolutionRate * 100)}%` : "—"} sub={o ? `${o.resolutionN} tagged` : ""} />
        <DashCard label="Online Devices" value={o ? String(o.onlineDevices) : "—"} badge="ONLINE" />
      </div>

      <div className="dash-2col">
        <section className="panel">
          <header>Call Volume Trend</header>
          <div style={{ padding: 16 }}>
            {o && o.volume.length > 0 ? <VolumeChart data={o.volume} /> : <div className="empty">No calls in this period.</div>}
          </div>
        </section>
        <section className="panel">
          <header>Active Extensions</header>
          <div className="live-ext">
            {!data ? (
              <div className="empty">Loading…</div>
            ) : data.live.length === 0 ? (
              <div className="empty">No extensions online.</div>
            ) : (
              data.live.slice(0, 8).map((e) => <LiveExtRow key={e.extension} e={e} />)
            )}
          </div>
        </section>
      </div>

      <LiveCalls notify={notify} />
      <AgentDevices />
    </>
  );
}

function LiveExtRow({ e }: { e: LiveExtension }) {
  const badge =
    e.status === "in_call" ? { c: "badge-live", t: "IN CALL" } : e.status === "wrap" ? { c: "badge-wrap", t: "WRAP-UP" } : { c: "badge-online", t: "ONLINE" };
  return (
    <div className="live-ext-row">
      <div className="lx-avatar">{(e.displayName || e.extension).slice(0, 2).toUpperCase()}</div>
      <div className="lx-main">
        <div className="lx-name">{e.displayName || e.extension}</div>
        <div className="lx-ext">EXT-{e.extension}</div>
      </div>
      <span className={`ext-badge ${badge.c}`}>{badge.t}</span>
    </div>
  );
}

// --- Extensions -------------------------------------------------------------

function ExtensionsView({ days, notify }: { days: number; notify: Notify }) {
  const [exts, setExts] = useState<Extension[]>([]);
  const [sel, setSel] = useState("");
  const [d, setD] = useState<ExtensionDetail | null>(null);

  useEffect(() => {
    listExtensions().then((r) => {
      setExts(r);
      if (r.length && !sel) setSel(r[0].id);
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!sel) return;
    getExtensionDetail(sel, days).then(setD).catch((e) => notify({ kind: "err", text: (e as Error).message }));
  }, [sel, days, notify]);

  return (
    <>
      <div className="ext-picker">
        <label>Extension</label>
        <select value={sel} onChange={(e) => setSel(e.target.value)}>
          {exts.map((x) => (
            <option key={x.id} value={x.id}>
              {x.id} {x.callerId ? `· ${x.callerId}` : ""}
            </option>
          ))}
        </select>
      </div>

      {!d ? (
        <section className="panel"><div className="empty">Select an extension.</div></section>
      ) : (
        <>
          <div className="dash-cards">
            <DashCard label="Avg Call Time" value={fmtDur(d.avgCallSeconds)} />
            <DashCard label="Calls Today" value={String(d.callsToday)} />
            <DashCard label="Hangup Rate" value={`${(d.hangupRate * 100).toFixed(1)}%`} />
          </div>

          <div className="dash-2col">
            <section className="panel">
              <header>Nature of Calls</header>
              <div style={{ padding: 16 }}>
                {d.nature.length === 0 ? <div className="empty">No tagged calls yet.</div> : d.nature.map((s) => <BarRow key={s.label} s={s} />)}
              </div>
            </section>
            <section className="panel">
              <header>Hangup Causes</header>
              <div style={{ padding: 16 }}>
                {d.hangupCauses.length === 0 ? <div className="empty">No tagged causes yet.</div> : d.hangupCauses.map((s) => <BarRow key={s.label} s={s} tone="red" />)}
              </div>
            </section>
          </div>

          <section className="panel">
            <header>Recent Activity Timeline</header>
            <div className="timeline">
              {d.timeline.length === 0 ? (
                <div className="empty">No recent activity.</div>
              ) : (
                d.timeline.map((t, i) => (
                  <div key={i} className={`tl-item ${t.kind}`}>
                    <span className="tl-dot" />
                    <div className="tl-body">
                      <div className="tl-title">{t.title}</div>
                      {t.detail && <div className="tl-detail">{t.detail}</div>}
                    </div>
                    <span className="tl-time">{new Date(t.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      )}
    </>
  );
}

function BarRow({ s, tone }: { s: DashSlice; tone?: "red" }) {
  return (
    <div className="bar-row">
      <div className="bar-top">
        <span>{cap(s.label)}</span>
        <span className="bar-pct">{Math.round(s.pct * 100)}%</span>
      </div>
      <div className="bar-track">
        <div className={`bar-fill ${tone || ""}`} style={{ width: `${Math.round(s.pct * 100)}%` }} />
      </div>
    </div>
  );
}

// --- Reports ----------------------------------------------------------------

function ReportsView({ days, notify }: { days: number; notify: Notify }) {
  const [r, setR] = useState<ReportsStats | null>(null);
  useEffect(() => {
    getReports(days).then(setR).catch((e) => notify({ kind: "err", text: (e as Error).message }));
  }, [days, notify]);

  if (!r) return <section className="panel"><div className="empty">Loading…</div></section>;

  return (
    <>
      <div className="dash-cards">
        <DashCard label="Peak Call Volume" value={r.peakVolume.toLocaleString()} sub="busiest day" />
        <DashCard label="Common Hangup Reason" value={r.commonHangupReason ? cap(r.commonHangupReason) : "—"} />
        <DashCard label="Top Performing Ext" value={r.topExtension ? `EXT-${r.topExtension}` : "—"} sub={r.topExtension ? `${Math.round(r.topExtensionRate * 100)}% resolved · ${r.topExtensionName}` : ""} />
      </div>

      <div className="dash-2col">
        <section className="panel">
          <header>Call Volume Trends</header>
          <div style={{ padding: 16 }}>
            <TrendChart thisWeek={r.thisWeek} lastWeek={r.lastWeek} />
          </div>
        </section>
        <section className="panel">
          <header>Key Insights</header>
          <div className="insights">
            {r.insights.map((t, i) => (
              <div key={i} className="insight">
                <span className="ins-dot" />
                {t}
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel">
        <header>Agent Performance Ranking</header>
        {r.ranking.length === 0 ? (
          <div className="empty">No tagged calls in this period.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Extension</th>
                  <th>Avg Handle Time</th>
                  <th>Resolution Rate</th>
                  <th>Trend</th>
                </tr>
              </thead>
              <tbody>
                {r.ranking.map((row) => (
                  <tr key={row.extension}>
                    <td><strong>{row.displayName || row.extension}</strong></td>
                    <td>EXT-{row.extension}</td>
                    <td>{fmtDur(row.ahtSeconds)}</td>
                    <td>
                      <div className="res-bar">
                        <div className="res-fill" style={{ width: `${Math.round(row.resolutionRate * 100)}%` }} />
                        <span>{Math.round(row.resolutionRate * 100)}%</span>
                      </div>
                    </td>
                    <td className={`trend ${row.trend}`}>{row.trend === "up" ? "↗ improving" : row.trend === "down" ? "↘ slipping" : "→ steady"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// --- Cards & charts ---------------------------------------------------------

function DashCard({ label, value, sub, badge }: { label: string; value: string; sub?: string; badge?: string }) {
  return (
    <div className="dash-card">
      <div className="dc-label">{label}</div>
      <div className="dc-value">
        {value}
        {badge && <span className="ext-badge badge-online">{badge}</span>}
      </div>
      {sub && <div className="dc-sub">{sub}</div>}
    </div>
  );
}

// VolumeChart draws grouped inbound/outbound bars per day as inline SVG.
function VolumeChart({ data }: { data: OverviewResponse["overview"]["volume"] }) {
  const w = 520, h = 180, pad = 24;
  const max = Math.max(1, ...data.map((d) => Math.max(d.inbound, d.outbound)));
  const n = data.length;
  const bw = (w - pad * 2) / Math.max(1, n) / 3;
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ maxWidth: w }}>
        {data.map((d, i) => {
          const x = pad + ((w - pad * 2) / Math.max(1, n)) * i + bw / 2;
          const inH = (d.inbound / max) * (h - pad * 2);
          const outH = (d.outbound / max) * (h - pad * 2);
          return (
            <g key={i}>
              <rect x={x} y={h - pad - inH} width={bw} height={inH} rx={2} fill="var(--g)" />
              <rect x={x + bw + 3} y={h - pad - outH} width={bw} height={outH} rx={2} fill="var(--g-line)" />
              <text x={x + bw} y={h - pad + 12} fontSize="9" textAnchor="middle" fill="var(--muted)">{d.label}</text>
            </g>
          );
        })}
      </svg>
      <div className="chart-legend">
        <span><i style={{ background: "var(--g)" }} /> Inbound</span>
        <span><i style={{ background: "var(--g-line)" }} /> Outbound</span>
      </div>
    </div>
  );
}

// TrendChart overlays this-week vs last-week daily counts as two polylines.
function TrendChart({ thisWeek, lastWeek }: { thisWeek: number[]; lastWeek: number[] }) {
  const w = 520, h = 180, pad = 20;
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const max = Math.max(1, ...thisWeek, ...lastWeek);
  const pts = (arr: number[]) =>
    arr.map((v, i) => `${pad + ((w - pad * 2) / 6) * i},${h - pad - (v / max) * (h - pad * 2)}`).join(" ");
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ maxWidth: w }}>
        <polyline points={pts(lastWeek)} fill="none" stroke="var(--g-line)" strokeWidth="2.5" />
        <polyline points={pts(thisWeek)} fill="none" stroke="var(--g)" strokeWidth="2.5" />
        {days.map((d, i) => (
          <text key={i} x={pad + ((w - pad * 2) / 6) * i} y={h - 4} fontSize="9" textAnchor="middle" fill="var(--muted)">{d}</text>
        ))}
      </svg>
      <div className="chart-legend">
        <span><i style={{ background: "var(--g)" }} /> This week</span>
        <span><i style={{ background: "var(--g-line)" }} /> Last week</span>
      </div>
    </div>
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
        While a call is up, the link animates to show media is flowing. When
        the system reports per-leg RTP counters, a green <strong>▲ voice</strong>{" "}
        tag marks a party whose audio is reaching the PBX and{" "}
        <strong>▲ no audio</strong> flags a leg that isn't sending — the usual
        cause of one-way audio — with dots travelling in the direction audio
        flows.
      </p>
    </section>
  );
}

// AgentDevices shows every extension as a small tile: device illustration, an
// online/offline dot, the number, and the IP it is registered from.
function AgentDevices() {
  const [rows, setRows] = useState<Extension[]>([]);
  const [status, setStatus] = useState<Record<string, ExtStatus>>({});

  useEffect(() => {
    listExtensions().then(setRows).catch(() => {});
  }, []);

  const poll = useCallback(() => {
    getExtensionStatus().then(setStatus).catch(() => {});
  }, []);
  useEffect(() => {
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, [poll]);

  const onlineCount = rows.filter((e) => status[e.id]?.online).length;

  return (
    <section className="panel">
      <header>
        Agent Devices
        <span style={{ float: "right", color: "var(--muted)", textTransform: "none", letterSpacing: 0 }}>
          {onlineCount}/{rows.length} online
        </span>
      </header>
      {rows.length === 0 ? (
        <div className="empty">No extensions.</div>
      ) : (
        <div className="ext-tiles">
          {rows.map((e) => {
            const st = status[e.id];
            const online = !!st?.online;
            const device = st?.device && st.device !== "none" ? st.device : e.webrtc ? "web" : "desk";
            return (
              <div className={`ext-tile ${online ? "on" : "off"}`} key={e.id} title={online ? "Registered" : "Offline"}>
                <span className={`tile-dot ${online ? "on" : "off"}`} />
                <span className="tile-ico">
                  <DeviceIcon kind={device} />
                </span>
                <span className="tile-num">{e.id}</span>
                <span className="tile-ip">
                  {online ? (st?.ip ? `from ${st.ip}` : "registered") : "offline"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

