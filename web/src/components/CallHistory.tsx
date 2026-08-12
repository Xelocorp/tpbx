import { useCallback, useEffect, useState } from "react";
import { listCDR, type CDRRecord, type Me } from "../api";
import type { Notify } from "../types";

const PAGE = 25;
const DISPOSITIONS = ["", "ANSWERED", "NO ANSWER", "BUSY", "FAILED"];

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Call history is read-only (records come from Asterisk's CDR); the `me` prop
// is accepted for a uniform component signature but no actions are gated here.
export default function CallHistory({ notify }: { notify: Notify; me: Me }) {
  const [rows, setRows] = useState<CDRRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState("");
  const [disposition, setDisposition] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    listCDR({ q, disposition, limit: PAGE, offset })
      .then((p) => {
        setRows(p.records);
        setTotal(p.total);
      })
      .catch((e) => notify({ kind: "err", text: (e as Error).message }))
      .finally(() => setLoading(false));
  }, [q, disposition, offset, notify]);

  useEffect(load, [load]);

  const dispClass = (d: string) =>
    d === "ANSWERED" ? "badge" : "badge offline";

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE, total);

  return (
    <>
      <div className="page-head">
        <h2>Call History</h2>
      </div>

      <section className="panel">
        <header>Call Detail Records</header>
        <div className="form" style={{ paddingBottom: 0 }}>
          <div className="form-row">
            <label>
              Search (number / caller ID)
              <input
                value={q}
                placeholder="e.g. 1001 or 79222248"
                onChange={(e) => {
                  setOffset(0);
                  setQ(e.target.value);
                }}
              />
            </label>
            <label>
              Disposition
              <select
                value={disposition}
                onChange={(e) => {
                  setOffset(0);
                  setDisposition(e.target.value);
                }}
              >
                {DISPOSITIONS.map((d) => (
                  <option key={d} value={d}>
                    {d || "All"}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {loading ? (
          <div className="empty">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="empty">No call records match.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>From</th>
                <th>To</th>
                <th>Talk time</th>
                <th>Disposition</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>{new Date(c.callDate).toLocaleString()}</td>
                  <td>{c.src || c.clid || "-"}</td>
                  <td>{c.dst || "-"}</td>
                  <td>{c.billsec > 0 ? fmtDuration(c.billsec) : "-"}</td>
                  <td>
                    <span className={dispClass(c.disposition)}>
                      {c.disposition || "unknown"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="pager">
          <span>
            {from}–{to} of {total}
          </span>
          <span>
            <button
              className="btn ghost small"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              ‹ Prev
            </button>
            <button
              className="btn ghost small"
              disabled={to >= total}
              onClick={() => setOffset(offset + PAGE)}
            >
              Next ›
            </button>
          </span>
        </div>
      </section>
    </>
  );
}
