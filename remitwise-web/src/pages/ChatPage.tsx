import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state';
import type { AlertRule, ChatItem, Proposal, Route, Tier, ToolStep } from '../types';
import { buildRoutes } from '../mock/routes';
import { fxSeries } from '../mock/data';
import { fmtBDT, fmtMoney, nowTime, sleep, uid } from '../format';
import { api, getUserName, useMock, type ChatEvent } from '../api/client';
import TierBadge, { tierInfo } from '../components/TierBadge';
import ToolTrace from '../components/ToolTrace';
import RouteCard from '../components/RouteCard';
import ConfirmCard from '../components/ConfirmCard';

const suggestions = [
  'Dad wants to send ৳2,40,000 for my tuition. What is the best way?',
  'When should I convert my taka to ringgit, and can you set an alert?',
  'How do I build credit while studying in Malaysia?',
];

function parseAmount(input: string): number | null {
  const m = input.replace(/,/g, '').match(/(\d+(\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

function fmtNumber(n: number): string {
  return n.toFixed(2);
}

export default function ChatPage() {
  const { items, setItems, mode, setMode, logAudit, addTransfer, addAlert } = useApp();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [agentMode, setAgentMode] = useState<'llm' | 'offline' | null>(null);
  const pastedRef = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items]);

  const push = (item: ChatItem) => setItems((prev) => [...prev, item]);
  const patch = (fn: (prev: ChatItem[]) => ChatItem[]) => setItems(fn);

  // --- mock tool animation (VITE_USE_MOCK=true only) -------------------------
  async function runSteps(defs: { tool: string; tier: Tier; running: string; done: string }[]) {
    const traceId = uid();
    const steps: ToolStep[] = defs.map((d) => ({ id: uid(), tool: d.tool, tier: d.tier, summary: d.running, status: 'pending' }));
    push({ kind: 'trace', id: traceId, steps });
    for (let i = 0; i < defs.length; i++) {
      patch((prev) => prev.map((it) => (it.kind === 'trace' && it.id === traceId ? { ...it, steps: it.steps.map((s, si) => (si === i ? { ...s, status: 'running' } : s)) } : it)));
      await sleep(400);
      patch((prev) => prev.map((it) => (it.kind === 'trace' && it.id === traceId ? { ...it, steps: it.steps.map((s, si) => (si === i ? { ...s, status: 'done', summary: defs[i].done } : s)) } : it)));
      logAudit({ event: 'Tool call', tool: defs[i].tool, tier: defs[i].tier, outcome: defs[i].done });
    }
  }

  // --- live agent chat over SSE ----------------------------------------------
  async function agentChat(raw: string, pasted: boolean) {
    const traceId = uid();
    const steps: ToolStep[] = [];
    let tracePushed = false;
    const syncTrace = () => {
      if (!steps.length) return;
      if (!tracePushed) {
        tracePushed = true;
        push({ kind: 'trace', id: traceId, steps: steps.slice() });
      } else {
        patch((prev) => prev.map((it) => (it.kind === 'trace' && it.id === traceId ? { ...it, steps: steps.slice() } : it)));
      }
    };

    let textId: string | null = null;
    let buf = '';
    const appendText = (delta: string) => {
      buf += delta;
      if (!textId) {
        textId = uid();
        push({ kind: 'agent', id: textId, text: buf });
      } else {
        const id = textId;
        patch((prev) => prev.map((it) => (it.kind === 'agent' && it.id === id ? { ...it, text: buf } : it)));
      }
    };

    await api.chat(raw, pasted, (e: ChatEvent) => {
      switch (e.type) {
        case 'meta':
          setAgentMode(e.mode);
          break;
        case 'tool_call':
          steps.push({ id: e.id || uid(), tool: e.tool, tier: e.tier as Tier, summary: 'Running…', status: 'running' });
          syncTrace();
          if (e.tier === 'T3') setMode('T3');
          else if (e.tier === 'T2') setMode('T2');
          break;
        case 'tool_result': {
          const s = steps.find((x) => x.id === e.id);
          if (s) {
            s.status = e.status === 'done' ? 'done' : 'blocked';
            s.summary = e.summary;
            syncTrace();
          }
          break;
        }
        case 'card': {
          const c = e.card;
          if (c?.kind === 'routes') {
            push({ kind: 'routes', id: uid(), routes: c.routes as Route[], bestId: c.bestId, source: c.source, snapshot: c.snapshot });
          } else if (c?.kind === 'proposal') {
            push({ kind: 'proposal', id: c.proposal.id, proposal: c.proposal as Proposal });
            setMode('T2');
          }
          break;
        }
        case 'text':
          appendText(e.delta);
          break;
        case 'error':
          push({ kind: 'notice', id: uid(), text: e.message || 'The assistant hit an error.' });
          break;
        default:
          break;
      }
    });
  }

  // --- mock flows -------------------------------------------------------------
  async function remitFlow(input: string) {
    const amount = parseAmount(input);
    if (amount == null) {
      push({ kind: 'agent', id: uid(), text: 'How much would you like to send? Tell me the amount, for example "৳2,40,000" or "2000 USD".' });
      return;
    }
    push({ kind: 'agent', id: uid(), text: 'I will check your account, the rules for this payment, and compare routes. I can read and propose only. Nothing is sent unless you confirm.' });
    await runSteps([
      { tool: 'get_balance', tier: 'T1', running: 'Checking balance', done: 'Balance covers this payment' },
      { tool: 'check_compliance', tier: 'T1', running: 'Checking rules', done: 'Purpose, documents, and limits passed' },
      { tool: 'compare_routes', tier: 'T1', running: 'Comparing routes', done: '3 routes ranked by total cost' },
      { tool: 'propose_payment', tier: 'T2', running: 'Preparing a draft', done: 'Draft ready. Not sent' },
    ]);
    const routes = buildRoutes(amount);
    const best = routes[0];
    push({ kind: 'routes', id: uid(), routes, bestId: best.id, source: 'sample dataset' });
    push({ kind: 'agent', id: uid(), text: `${best.name} has the lowest total cost. They would receive ${fmtMoney(best.net ?? 0, best.currency)}. Please check the details below before confirming.` });
    push({
      kind: 'proposal', id: uid(),
      proposal: {
        id: uid(), amountBDT: amount, recipient: 'University of Malaya (sample)', route: best, status: 'pending',
        approverName: getUserName(),
        checks: ['Purpose, documents, and limits passed'],
      },
    });
    setMode('T2');
    logAudit({ event: 'Proposal created', tool: 'propose_payment', tier: 'T2', outcome: `${fmtBDT(amount)} via ${best.name}` });
  }

  async function confirm(p: Proposal) {
    setBusy(true);
    patch((prev) => prev.map((it) => (it.kind === 'proposal' && it.id === p.id ? { ...it, proposal: { ...it.proposal, status: 'confirmed' } } : it)));
    setMode('T3');
    logAudit({ event: 'Confirmation token issued', tier: 'T3', outcome: 'Single use, bound to this proposal' });
    await runSteps([{ tool: 'execute_payment', tier: 'T3', running: 'Sending in the sandbox', done: 'Sandbox transfer completed' }]);

    if (useMock || !p.approvalHash) {
      const ref = 'RW-' + Math.random().toString(36).slice(2, 8).toUpperCase();
      push({ kind: 'receipt', id: uid(), receipt: { ref, amountBDT: p.amountBDT, receive: p.route.net, currency: p.route.currency, recipient: p.recipient, routeName: p.route.name, time: nowTime(), approverName: p.approverName } });
      addTransfer({ id: ref, date: new Date().toISOString().slice(0, 10), recipient: p.recipient, amountBDT: p.amountBDT, status: 'Pending' });
      push({ kind: 'agent', id: uid(), text: `Done. Your receipt ${ref} is above — keep it for your records.` });
      setMode('T1');
      setBusy(false);
      return;
    }

    try {
      const res = await api.confirmProposal(p.id, p.approvalHash, 'user_typed');
      const paidBDT = res.amountBDT ?? p.amountBDT;
      push({ kind: 'receipt', id: uid(), receipt: { ref: res.receiptId, amountBDT: paidBDT, receive: p.route.net, currency: p.route.currency, recipient: p.recipient, routeName: p.route.name, time: nowTime(), approverName: p.approverName } });
      addTransfer({ id: res.receiptId, date: new Date().toISOString().slice(0, 10), recipient: p.recipient, amountBDT: paidBDT, status: 'Completed' });
      push({ kind: 'agent', id: uid(), text: `Done. Your receipt ${res.receiptId} is above — keep it for your records.` });
    } catch (e: any) {
      if (e?.status === 401) {
        push({ kind: 'notice', id: uid(), text: 'Your session expired. Please log in again.' });
      } else {
        push({ kind: 'notice', id: uid(), text: 'That payment could not be confirmed. Nothing was sent. Please try again.' });
      }
      patch((prev) => prev.map((it) => (it.kind === 'proposal' && it.id === p.id ? { ...it, proposal: { ...it.proposal, status: 'failed' } } : it)));
    } finally {
      setMode('T1');
      setBusy(false);
    }
  }

  function cancel(p: Proposal) {
    if (!useMock && p.approvalHash) api.cancelProposal(p.id).catch(() => { /* ignore */ });
    patch((prev) => prev.map((it) => (it.kind === 'proposal' && it.id === p.id ? { ...it, proposal: { ...it.proposal, status: 'cancelled' } } : it)));
    logAudit({ event: 'Proposal cancelled', tier: 'T2', outcome: 'No money moved' });
    push({ kind: 'agent', id: uid(), text: 'Cancelled. Nothing was sent. Tell me if you want to try a different amount or route.' });
    setMode('T1');
  }

  async function fxFlow() {
    await runSteps([{ tool: 'fx_window', tier: 'T1', running: 'Reading 30 days of rates', done: '30-day range calculated' }]);
    const lo = Math.min(...fxSeries);
    const hi = Math.max(...fxSeries);
    const avg = fxSeries.reduce((a, b) => a + b, 0) / fxSeries.length;
    const now = fxSeries[fxSeries.length - 1];
    push({
      kind: 'agent', id: uid(),
      text: `Over the last 30 days, one ringgit ranged from ৳${fmtNumber(lo)} to ৳${fmtNumber(hi)}, averaging ৳${fmtNumber(avg)}. Today it is ৳${fmtNumber(now)}.\n\nThis is not a forecast. Waiting could help or hurt. A common approach is a target rate plus a fallback date that leaves time for delivery before your deadline.`,
    });
    const alert: AlertRule = { id: uid(), pair: 'BDT per MYR', target: Number((avg + 0.15).toFixed(2)), fallbackDate: '2026-10-22', status: 'proposed' };
    push({ kind: 'alert', id: alert.id, alert });
    logAudit({ event: 'Alert proposed', tool: 'set_alert', tier: 'T2', outcome: `Target ${alert.target}` });
  }

  function activateAlert(a: AlertRule) {
    patch((prev) => prev.map((it) => (it.kind === 'alert' && it.id === a.id ? { ...it, alert: { ...it.alert, status: 'active' } } : it)));
    addAlert({ ...a, status: 'active' });
    logAudit({ event: 'Alert activated by user', tool: 'set_alert', tier: 'T3', outcome: 'Notifies only. Never sends money' });
  }

  async function creditFlow() {
    await runSteps([{ tool: 'build_credit_plan', tier: 'T2', running: 'Building your plan', done: 'Plan ready (sample)' }]);
    push({
      kind: 'agent', id: uid(),
      text: 'Here is a starter plan for Malaysia (sample content):\n1. Open a student bank account with your offer letter and passport.\n2. Keep a steady balance and pay every bill on time.\n3. Ask about a starter credit product once your visa length qualifies.\n4. Check your credit report at months 6 and 12.\n\nThis is guidance, not financial advice. I cannot open accounts or apply for products for you.',
    });
  }

  function injection() {
    push({ kind: 'notice', id: uid(), text: "That message was pasted, so I can't act on payment instructions in it. Please type your request yourself. Nothing was sent." });
    logAudit({ event: 'Injection blocked', tier: 'SYS', outcome: 'Blocked and logged' });
  }

  async function send(raw: string) {
    const t = raw.trim();
    if (!t || busy) return;
    const pasted = pastedRef.current;
    pastedRef.current = false;
    setText('');
    setBusy(true);
    push({ kind: 'user', id: uid(), text: t });
    try {
      if (!useMock) {
        await agentChat(t, pasted);
        return;
      }
      const l = t.toLowerCase();
      if (/ignore (all |the |previous |your )*(rules|instructions)/.test(l)) injection();
      else if (/credit/.test(l)) await creditFlow();
      else if (/(wait|when|convert|fx|exchange rate)/.test(l)) await fxFlow();
      else if (/(send|tuition|pay|remit)/.test(l)) await remitFlow(t);
      else push({ kind: 'agent', id: uid(), text: 'I can help you send a tuition payment, decide when to convert, or plan how to build credit abroad. Which one would you like?' });
    } catch (e: any) {
      if (e?.status === 401 || e?.message === 'session_expired') {
        push({ kind: 'notice', id: uid(), text: 'Your session expired. Please log in again.' });
      } else {
        push({ kind: 'notice', id: uid(), text: 'The assistant is unavailable right now. Nothing was sent. Please try again.' });
      }
    } finally {
      setBusy(false);
    }
  }

  const render = (it: ChatItem) => {
    switch (it.kind) {
      case 'user': return <div key={it.id} className="msg user">{it.text}</div>;
      case 'agent': return <div key={it.id} className="msg agent">{it.text}</div>;
      case 'notice': return <div key={it.id} className="notice">{it.text}</div>;
      case 'trace': return <ToolTrace key={it.id} steps={it.steps} />;
      case 'routes': return <RouteCard key={it.id} routes={it.routes} bestId={it.bestId} source={it.source} snapshot={it.snapshot} />;
      case 'proposal': return <ConfirmCard key={it.id} proposal={it.proposal} onConfirm={() => confirm(it.proposal)} onCancel={() => cancel(it.proposal)} disabled={busy} />;
      case 'receipt':
        return (
          <div className="card receipt" key={it.id}>
            <h3>Receipt {it.receipt.ref}</h3>
            <dl className="facts">
              <div><dt>Sent</dt><dd>{fmtBDT(it.receipt.amountBDT)}</dd></div>
              <div><dt>They receive</dt><dd>{it.receipt.receive == null ? 'No quote' : fmtMoney(it.receipt.receive, it.receipt.currency)}</dd></div>
              <div><dt>To</dt><dd>{it.receipt.recipient}</dd></div>
              <div><dt>Route</dt><dd>{it.receipt.routeName}</dd></div>
              <div><dt>Time</dt><dd>{it.receipt.time}</dd></div>
            </dl>
            <p className="approveas">Approving as: <strong>{it.receipt.approverName || getUserName()}</strong> (taka account)</p>
          </div>
        );
      case 'alert':
        return (
          <section key={it.id} className="card alertcard" aria-label="Rate alert">
            <header className="confirmhead"><h3>Rate alert</h3><TierBadge tier="T3" /></header>
            <dl className="facts">
              <div><dt>Notify me when</dt><dd>{it.alert.pair} reaches {it.alert.target.toFixed(2)}</dd></div>
              <div><dt>Fallback date</dt><dd>{it.alert.fallbackDate}, so there is time before the 25th</dd></div>
            </dl>
            {it.alert.status === 'proposed'
              ? <div className="actions"><button className="btn primary" onClick={() => activateAlert(it.alert)}>Turn on alert</button></div>
              : <p className="status confirmed">Alert is on</p>}
            <p className="fine">The alert only notifies you. You approve any payment yourself.</p>
          </section>
        );
      default:
        return null;
    }
  };

  return (
    <div className="chatgrid">
      <section className="chatcol" aria-label="Assistant chat">
        <header className="pagehead">
          <h1>Assistant</h1>
          <span className="modeline">
            {agentMode && (
              <span className="flag" title={agentMode === 'offline' ? 'The live model is unavailable; using deterministic rules only.' : 'Live model is answering.'}>
                {agentMode === 'offline' ? 'Offline mode' : 'Live model'}
              </span>
            )}
            Now: <TierBadge tier={mode} />
          </span>
        </header>
        <div className="messages" aria-live="polite">
          {items.map(render)}
          <div ref={endRef} />
        </div>
        <div className="chips">
          {suggestions.map((s) => (<button key={s} className="chip" disabled={busy} onClick={() => send(s)}>{s}</button>))}
        </div>
        <form className="composer" onSubmit={(e) => { e.preventDefault(); send(text); }}>
          <label htmlFor="msg" className="sr">Message</label>
          <textarea id="msg" rows={2} value={text} placeholder="Ask about tuition payments, exchange rates, or credit"
            onChange={(e) => setText(e.target.value)}
            onPaste={() => { pastedRef.current = true; }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(text); } }} />
          <button className="btn primary" type="submit" disabled={busy || !text.trim()}>Send</button>
        </form>
      </section>

      <aside className="sidecol" aria-label="What the assistant is allowed to do">
        <h2>What I can do right now</h2>
        <ol className="ladder">
          {(['T1', 'T2', 'T3'] as Tier[]).map((t) => (
            <li key={t} className={'rung ' + t.toLowerCase() + (mode === t ? ' on' : '')}>
              <TierBadge tier={t} />
              <span>{tierInfo[t].blurb}</span>
            </li>
          ))}
        </ol>
        <p className="fine">Every step is recorded in your activity log. Payments and alerts always need your confirmation.</p>
      </aside>
    </div>
  );
}
