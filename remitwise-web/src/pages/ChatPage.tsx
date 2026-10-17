import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state';
import type { AlertRule, ChatItem, Proposal, Route, Tier, ToolStep } from '../types';
import { buildRoutes } from '../mock/routes';
import { fxSeries } from '../mock/data';
import { fmtBDT, fmtMoney, nowTime, sleep, uid } from '../format';
import { api, useMock } from '../api/client';
import TierBadge, { tierInfo } from '../components/TierBadge';
import ToolTrace from '../components/ToolTrace';
import RouteCard from '../components/RouteCard';
import ConfirmCard from '../components/ConfirmCard';

// The sandbox assistant defaults to the Bangladesh -> Malaysia education
// corridor. The server decides the destination currency from the corridor; the
// UI never assumes ringgit for other corridors.
const CORRIDOR = 'BD-MY';

const suggestions = [
  'Send 8000 USD tuition to my university in Malaysia',
  'When should I convert my taka to ringgit?',
  'How do I build credit while studying abroad?',
];

function parseAmount(input: string): number {
  const m = input.replace(/,/g, '').match(/(\d+(\.\d+)?)/);
  const n = m ? Number(m[1]) : 8000;
  return n > 0 ? n : 8000;
}

function fmtNumber(n: number): string {
  return n.toFixed(2);
}

export default function ChatPage() {
  const { items, setItems, mode, setMode, logAudit, addTransfer, addAlert } = useApp();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items]);

  const push = (item: ChatItem) => setItems((prev) => [...prev, item]);
  const patch = (fn: (prev: ChatItem[]) => ChatItem[]) => setItems(fn);

  async function runSteps(defs: { tool: string; tier: Tier; running: string; done: string }[]) {
    if (useMock) {
      const traceId = uid();
      const steps: ToolStep[] = defs.map((d) => ({ id: uid(), tool: d.tool, tier: d.tier, summary: d.running, status: 'pending' }));
      push({ kind: 'trace', id: traceId, steps });
      for (let i = 0; i < defs.length; i++) {
        patch((prev) => prev.map((it) => (it.kind === 'trace' && it.id === traceId ? { ...it, steps: it.steps.map((s, si) => (si === i ? { ...s, status: 'running' } : s)) } : it)));
        await sleep(400);
        patch((prev) => prev.map((it) => (it.kind === 'trace' && it.id === traceId ? { ...it, steps: it.steps.map((s, si) => (si === i ? { ...s, status: 'done', summary: defs[i].done } : s)) } : it)));
        logAudit({ event: 'Tool call', tool: defs[i].tool, tier: defs[i].tier, outcome: defs[i].done });
      }
    } else {
      for (const d of defs) logAudit({ event: 'Tool call', tool: d.tool, tier: d.tier, outcome: d.done });
    }
  }

  function checksFromRules(ruleResults: { ruleId: string; passed: boolean; status: string }[]): string[] {
    return ruleResults.filter((r) => r.passed && r.status === 'enforced').map((r) => `${r.ruleId} passed`);
  }

  function failureText(ruleResults: { ruleId: string; passed: boolean; userMessage: string }[]): string {
    const failed = ruleResults.filter((r) => !r.passed && r.userMessage);
    return failed.length ? failed.map((r) => `${r.ruleId}: ${r.userMessage}`).join('\n') : 'Compliance checks did not pass.';
  }

  async function remitFlow(input: string) {
    const amount = parseAmount(input);
    push({ kind: 'agent', id: uid(), text: 'I will check your account, the rules for this payment, and compare routes. I can read and propose only. Nothing is sent unless you confirm.' });

    if (useMock) {
      await runSteps([
        { tool: 'get_balance', tier: 'T1', running: 'Checking balance', done: 'Balance covers this payment' },
        { tool: 'check_compliance', tier: 'T1', running: 'Checking rules', done: 'Purpose, documents, and limits passed' },
        { tool: 'compare_routes', tier: 'T1', running: 'Comparing routes', done: '3 routes ranked by total cost' },
        { tool: 'propose_payment', tier: 'T2', running: 'Preparing a draft', done: 'Draft ready. Not sent' },
      ]);
      const routes = buildRoutes(amount);
      const best = routes[0];
      push({ kind: 'routes', id: uid(), routes, bestId: best.id });
      push({ kind: 'agent', id: uid(), text: `${best.name} has the lowest total cost. They would receive ${fmtMoney(best.net ?? 0, best.currency)}. Please check the details below before confirming.` });
      push({
        kind: 'proposal', id: uid(),
        proposal: {
          id: uid(), amountBDT: amount, recipient: 'University of Malaya (sample)', route: best, status: 'pending',
          checks: ['Purpose, documents, and limits passed'],
        },
      });
      setMode('T2');
      logAudit({ event: 'Proposal created', tool: 'propose_payment', tier: 'T2', outcome: `${fmtBDT(amount)} via ${best.name}` });
      return;
    }

    try {
      await runSteps([
        { tool: 'get_balance', tier: 'T1', running: 'Checking balance', done: 'Balance checked' },
        { tool: 'check_compliance', tier: 'T1', running: 'Checking rules', done: 'Compliance rules evaluated' },
        { tool: 'compare_routes', tier: 'T1', running: 'Comparing routes', done: 'Routes compared' },
        { tool: 'propose_payment', tier: 'T2', running: 'Preparing a draft', done: 'Draft ready. Not sent' },
      ]);

      const apiRoutes = await api.compareRoutes(CORRIDOR, amount);
      const routes: Route[] = apiRoutes.map((r: any, i: number) => ({
        id: `${r.provider}-${i}`,
        name: r.provider,
        feeBDT: r.feeBDT,
        spreadPct: r.spreadPct,
        etaDays: r.etaDays,
        note: r.dataType === 'estimated' ? 'estimated' : '',
        currency: r.currency,
        net: r.net,
        quotable: !!r.quotable,
        reason: r.reason ?? null,
        totalCostPct: r.totalCostPct,
      }));
      if (!routes.length) {
        push({ kind: 'agent', id: uid(), text: 'I could not find a route for that corridor yet.' });
        return;
      }
      const best = routes[0];
      push({ kind: 'routes', id: uid(), routes, bestId: best.id });

      if (!best.quotable || best.net == null) {
        push({ kind: 'agent', id: uid(), text: 'No quote: after the fee and the FX margin there would be nothing left to send, so I cannot prepare a payment for that amount. Try a larger amount.' });
        setMode('T1');
        logAudit({ event: 'No quote', tool: 'compare_routes', tier: 'T1', outcome: 'fee and margin exceed amount' });
        return;
      }

      const comp = await api.checkCompliance({ corridor: CORRIDOR, amountUSD: amount, purpose: 'tuition', beneficiaryType: 'institution', coveragePeriodMonths: 12, isFirstRelease: true });
      if (comp.decision !== 'pass') {
        push({ kind: 'agent', id: uid(), text: failureText(comp.ruleResults) });
        setMode('T1');
        logAudit({ event: 'Compliance blocked', tool: 'check_compliance', tier: 'T1', outcome: comp.decision });
        return;
      }

      const others = routes.filter((r) => r.quotable && r.net != null);
      const worstNet = others.length ? Math.min(...others.map((r) => r.net as number)) : best.net;
      push({ kind: 'agent', id: uid(), text: `${best.name} has the lowest total cost. They would receive ${fmtMoney(best.net, best.currency)}, which is ${fmtMoney(best.net - worstNet, best.currency)} more than the most expensive quotable option. Please check the details below before confirming.` });

      const proposal = await api.propose({ corridor: CORRIDOR, amountUSD: amount, purpose: 'tuition', beneficiaryType: 'institution', coveragePeriodMonths: 12, isFirstRelease: true, routeProvider: best.name });
      push({
        kind: 'proposal', id: proposal.id,
        proposal: {
          id: proposal.id,
          amountBDT: proposal.quote.sendBDT,
          recipient: 'University of Malaya (sample)',
          route: best,
          status: 'pending',
          checks: checksFromRules(proposal.ruleResults),
          rules: proposal.ruleResults,
          hash: proposal.payloadHash,
          notEnforced: proposal.notEnforced || [],
        },
      });
      setMode('T2');
      logAudit({ event: 'Proposal created', tool: 'propose_payment', tier: 'T2', outcome: `${fmtBDT(proposal.quote.sendBDT)} via ${best.name}` });
    } catch (e: any) {
      push({ kind: 'notice', id: uid(), text: `Could not reach the API: ${e?.message || e}` });
    }
  }

  async function confirm(p: Proposal) {
    setBusy(true);
    patch((prev) => prev.map((it) => (it.kind === 'proposal' && it.id === p.id ? { ...it, proposal: { ...it.proposal, status: 'confirmed' } } : it)));
    setMode('T3');
    logAudit({ event: 'Confirmation token issued', tier: 'T3', outcome: 'Single use, bound to this proposal' });
    await runSteps([{ tool: 'execute_payment', tier: 'T3', running: 'Sending in the sandbox', done: 'Sandbox transfer completed' }]);

    if (useMock || !p.hash) {
      const ref = 'RW-' + Math.random().toString(36).slice(2, 8).toUpperCase();
      push({ kind: 'receipt', id: uid(), receipt: { ref, amountBDT: p.amountBDT, receive: p.route.net, currency: p.route.currency, recipient: p.recipient, routeName: p.route.name, time: nowTime() } });
      addTransfer({ id: ref, date: new Date().toISOString().slice(0, 10), recipient: p.recipient, amountBDT: p.amountBDT, status: 'Pending' });
      setMode('T1');
      setBusy(false);
      return;
    }

    try {
      const res = await api.confirmProposal(p.id, p.hash, 'user_typed');
      push({ kind: 'receipt', id: uid(), receipt: { ref: res.receiptId, amountBDT: p.amountBDT, receive: p.route.net, currency: p.route.currency, recipient: p.recipient, routeName: p.route.name, time: nowTime() } });
      addTransfer({ id: res.receiptId, date: new Date().toISOString().slice(0, 10), recipient: p.recipient, amountBDT: p.amountBDT, status: 'Completed' });
    } catch (e: any) {
      const rules = e?.body?.ruleResults;
      push({ kind: 'notice', id: uid(), text: rules ? failureText(rules) : (e?.message || 'Payment refused') });
      patch((prev) => prev.map((it) => (it.kind === 'proposal' && it.id === p.id ? { ...it, proposal: { ...it.proposal, status: 'failed' } } : it)));
    } finally {
      setMode('T1');
      setBusy(false);
    }
  }

  function cancel(p: Proposal) {
    if (!useMock && p.hash) api.cancelProposal(p.id).catch(() => { /* ignore */ });
    patch((prev) => prev.map((it) => (it.kind === 'proposal' && it.id === p.id ? { ...it, proposal: { ...it.proposal, status: 'cancelled' } } : it)));
    logAudit({ event: 'Proposal cancelled by user', tier: 'T2', outcome: 'No money moved' });
    push({ kind: 'agent', id: uid(), text: 'Cancelled. Nothing was sent. Tell me if you want to try a different amount or route.' });
    setMode('T1');
  }

  async function fxFlow() {
    await runSteps([{ tool: 'fx_window', tier: 'T1', running: 'Reading 30 days of rates', done: '30-day range calculated' }]);

    let lo: number;
    let hi: number;
    let avg: number;
    let now: number;
    let pair = 'BDT per MYR';

    if (useMock) {
      lo = Math.min(...fxSeries);
      hi = Math.max(...fxSeries);
      avg = fxSeries.reduce((a, b) => a + b, 0) / fxSeries.length;
      now = fxSeries[fxSeries.length - 1];
    } else {
      try {
        const w = await api.fxWindow('MYR/BDT', 30);
        lo = w.best.rate;
        hi = w.worst.rate;
        avg = w.average;
        now = w.current.rate;
        pair = w.pair === 'MYR/BDT' ? 'BDT per MYR' : w.pair;
      } catch (e: any) {
        push({ kind: 'notice', id: uid(), text: `Could not read rates: ${e?.message || e}` });
        return;
      }
    }

    push({
      kind: 'agent', id: uid(),
      text: `Over the last 30 days, one ringgit ranged from ৳${fmtNumber(lo)} to ৳${fmtNumber(hi)}, averaging ৳${fmtNumber(avg)}. Today it is ৳${fmtNumber(now)}.\n\nThis is not a forecast. Waiting could help or hurt. A common approach is a target rate plus a fallback date that leaves time for delivery before your deadline.`,
    });
    const alert: AlertRule = { id: uid(), pair, target: Number((avg + 0.15).toFixed(2)), fallbackDate: '2026-10-22', status: 'proposed' };
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
    push({ kind: 'notice', id: uid(), text: 'Blocked by rule INJ_01. That instruction came from pasted text, not from you, so I did not act on it. Nothing was sent.' });
    logAudit({ event: 'Rule INJ_01 triggered', tier: 'SYS', outcome: 'Blocked and logged' });
  }

  async function send(raw: string) {
    const t = raw.trim();
    if (!t || busy) return;
    setText('');
    setBusy(true);
    push({ kind: 'user', id: uid(), text: t });
    const l = t.toLowerCase();
    try {
      if (/ignore (all |the |previous |your )*(rules|instructions)/.test(l)) injection();
      else if (/credit/.test(l)) await creditFlow();
      else if (/(wait|when|convert|fx|exchange rate)/.test(l)) await fxFlow();
      else if (/(send|tuition|pay|remit)/.test(l)) await remitFlow(t);
      else push({ kind: 'agent', id: uid(), text: 'I can help you send a tuition payment, decide when to convert, or plan how to build credit abroad. Which one would you like?' });
    } finally {
      setBusy(false);
    }
  }

  const render = (it: ChatItem) => {
    switch (it.kind) {
      case 'user': return <div key={it.id} className="msg user">{it.text}</div>;
      case 'agent': return <div key={it.id} className="msg agent">{it.text}</div>;
      case 'notice': return <div key={it.id} className="msg notice" role="alert">{it.text}</div>;
      case 'trace': return <ToolTrace key={it.id} steps={it.steps} />;
      case 'routes': return <RouteCard key={it.id} routes={it.routes} bestId={it.bestId} />;
      case 'proposal': return <ConfirmCard key={it.id} proposal={it.proposal} disabled={busy} onConfirm={() => confirm(it.proposal)} onCancel={() => cancel(it.proposal)} />;
      case 'receipt': return (
        <section key={it.id} className="card receipt" aria-label="Receipt">
          <h3>Payment receipt</h3>
          <dl className="facts">
            <div><dt>Reference</dt><dd><code>{it.receipt.ref}</code></dd></div>
            <div><dt>Sent</dt><dd>{fmtBDT(it.receipt.amountBDT)}</dd></div>
            <div><dt>They receive</dt><dd className="strong">{it.receipt.receive == null ? 'No quote' : fmtMoney(it.receipt.receive, it.receipt.currency)}</dd></div>
            <div><dt>To</dt><dd>{it.receipt.recipient}</dd></div>
            <div><dt>Route</dt><dd>{it.receipt.routeName}</dd></div>
            <div><dt>Time</dt><dd>{it.receipt.time}</dd></div>
          </dl>
          <p className="fine">Sandbox receipt. Recorded in your activity log.</p>
        </section>
      );
      case 'alert': return (
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
    }
  };

  return (
    <div className="chatgrid">
      <section className="chatcol" aria-label="Assistant chat">
        <header className="pagehead">
          <h1>Assistant</h1>
          <span className="modeline">Now: <TierBadge tier={mode} /></span>
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
          <textarea id="msg" rows={2} value={text} placeholder="Ask about tuition payments, exchange rates, or credit" onChange={(e) => setText(e.target.value)}
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
