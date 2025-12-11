// src/App.jsx
import React, { useEffect, useState, useRef, useMemo } from "react";
import { io } from "socket.io-client";
import { motion } from "framer-motion";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  CartesianGrid
} from "recharts";

/*
  CONFIG - change if needed:
  - GATEWAY_URL: where your Gateway is running (include port)
  - EXPLORER_BASE_URL: etherscan or blockscout tx url prefix for Sepolia (so tx links work)
*/
const GATEWAY_URL = "http://localhost:3000"; // <-- change to your gateway URL/IP if needed
const EXPLORER_BASE_URL = "https://sepolia.etherscan.io/tx/"; // or blockscout link if you prefer

export default function App() {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [latest, setLatest] = useState(null);
  const [history, setHistory] = useState([]); // array of points for chart
  const [flaggedEvents, setFlaggedEvents] = useState([]);
  const [loadingFlagged, setLoadingFlagged] = useState(true);

  // connect socket once
  useEffect(() => {
    socketRef.current = io(GATEWAY_URL, { transports: ["websocket"], reconnectionAttempts: 999 });

    socketRef.current.on("connect", () => setConnected(true));
    socketRef.current.on("disconnect", () => setConnected(false));

    socketRef.current.on("telemetry", (data) => {
      // telemetry contains: timestamp, distA, distB, trustA, trustB, controller, rpm, hash, flagged, deviceId
      setLatest(data);

      const point = {
        ts: data.timestamp || Date.now(),
        label: new Date((data.timestamp && data.timestamp < 1e12 ? data.timestamp * 1000 : data.timestamp) || Date.now()).toLocaleTimeString(),
        trustA: typeof data.trustA === "number" ? data.trustA : null,
        trustB: typeof data.trustB === "number" ? data.trustB : null,
        rpm: data.rpm ?? null
      };

      setHistory(prev => {
        const arr = [...prev, point];
        if (arr.length > 60) arr.shift(); // keep most recent 60 points
        return arr;
      });
    });

    socketRef.current.on("flaggedEvent", (event) => {
      setFlaggedEvents(prev => [event, ...prev].slice(0, 200));
    });

    socketRef.current.on("event_update", (u) => {
      // optional: update last event view when more details come
      // if event_update contains same eventId as latest, merge
      if (!u) return;
      if (u.payload && latest && u.payload.eventId === latest.eventId) {
        setLatest(prev => ({ ...prev, ...u }));
      }
    });

    return () => {
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, []);

  // initial load of flagged events
  useEffect(() => {
    setLoadingFlagged(true);
    fetch(`${GATEWAY_URL}/flagged-events`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) setFlaggedEvents(data);
      })
      .catch(err => {
        console.error("Error fetching flagged events:", err);
      })
      .finally(() => setLoadingFlagged(false));
  }, []);

  const latestTxHash = useMemo(() => {
    const found = flaggedEvents.find(e => e.txHash);
    return found ? found.txHash : null;
  }, [flaggedEvents]);

  return (
    <div className="app-root">
      <header className="topbar">
        <div className="brand">
          <h1>TrustScore Monitor</h1>
          <span className="subtitle">ESP32 → Gateway → Blockchain (Sepolia)</span>
        </div>
        <div className="status-row">
          <div className={`status-pill ${connected ? "ok" : "bad"}`}>
            {connected ? "Connected" : "Disconnected"}
          </div>
          <div className="small">Gateway: {GATEWAY_URL.replace("http://localhost:3001/", "")}</div>
        </div>
      </header>

      <main className="main-grid">
        <section className="left panel">
          <div className="panel-header">
            <h2>Live TrustScore Trend</h2>
            <div className="meta">Recent trust comparison (A vs B)</div>
          </div>

          <div className="chart-area">
            {history.length === 0 ? (
              <div className="empty">Waiting for telemetry...</div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={history}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#0b1220" />
                  <XAxis dataKey="label" tick={{ fill: "#bcd3ff" }} />
                  <YAxis domain={[0, 100]} tick={{ fill: "#bcd3ff" }} />
                  <Tooltip wrapperStyle={{ background: "#071124", border: "1px solid #0f2a50" }} contentStyle={{ color: "#fff" }} />
                  <Legend wrapperStyle={{ color: "#bcd3ff" }} />
                  <Line type="monotone" dataKey="trustA" name="Trust A" stroke="#5cc8ff" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="trustB" name="Trust B" stroke="#9be564" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="kpi-row">
            <div className="kpi">
              <div className="kpi-label">Active Controller</div>
              <div className="kpi-value">{latest?.controller ?? "—"}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Motor RPM</div>
              <div className="kpi-value">{latest?.rpm ?? "—"}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Latest Tx</div>
              <div className="kpi-value smalllink">
                {latestTxHash ? <a href={`${EXPLORER_BASE_URL}${latestTxHash}`} target="_blank" rel="noreferrer">{short(latestTxHash)}</a> : "No tx yet"}
              </div>
            </div>
          </div>
        </section>

        <aside className="right panel">
          <div className="panel-header">
            <h3>Live Telemetry</h3>
            <div className="meta">Most recent reading</div>
          </div>

          <div className="telemetry">
            <Row label="Device ID">{latest?.deviceId ?? "—"}</Row>
            <Row label="distA">{latest?.distA ?? "—"} cm</Row>
            <Row label="TS_A">{latest?.trustA ?? "—"}</Row>
            <Row label="distB">{latest?.distB ?? "—"} cm</Row>
            <Row label="TS_B">{latest?.trustB ?? "—"}</Row>
            <Row label="Controller">{latest?.controller ?? "—"}</Row>
            <Row label="Flagged">{latest?.flagged ? <span className="flag">YES</span> : <span className="ok">NO</span>}</Row>
            <Row label="Payload Hash">{latest?.hash ? short(latest.hash) : "—"}</Row>
          </div>

          <div className="panel-header" style={{ marginTop: 12 }}>
            <h3>Flagged Events</h3>
            <div className="meta">Recent events sent to blockchain</div>
          </div>

          <div className="events-list">
            {loadingFlagged ? (
              <div className="empty">Loading...</div>
            ) : flaggedEvents.length === 0 ? (
              <div className="empty">No flagged events yet</div>
            ) : (
              <table className="events-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>TS_A</th>
                    <th>TS_B</th>
                    <th>Ctrl</th>
                    <th>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {flaggedEvents.slice(0, 50).map((e, i) => (
                    <tr key={i}>
                      <td>{formatTime(e.timestamp)}</td>
                      <td>{e.trustA ?? "—"}</td>
                      <td>{e.trustB ?? "—"}</td>
                      <td>{e.controller ?? (e.trustA >= e.trustB ? "A" : "B")}</td>
                      <td>{e.txHash ? <a href={`${EXPLORER_BASE_URL}${e.txHash}`} target="_blank" rel="noreferrer">{short(e.txHash)}</a> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </aside>
      </main>

      <footer className="footer">
        <div>Gateway: {GATEWAY_URL}</div>
        <div>Contract events logged on Sepolia</div>
      </footer>
    </div>
  );
}

/* ---------- Small components & helpers ---------- */

function Row({ label, children }) {
  return (
    <div className="row">
      <div className="row-label">{label}</div>
      <div className="row-value">{children}</div>
    </div>
  );
}

function short(s, len = 12) {
  if (!s) return "";
  if (s.length <= len) return s;
  return s.slice(0, 8) + "…" + s.slice(-6);
}

function formatTime(ts) {
  if (!ts) return "—";
  // ts might be seconds or ms
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return new Date(ms).toLocaleTimeString();
}
