import { createContext, useCallback, useContext, useMemo, useState, type Dispatch, type SetStateAction, type ReactNode } from 'react';
import type { AlertRule, AuditEvent, ChatItem, Tier, Transfer } from './types';
import { initialAlerts, initialAudit, initialChat, initialTransfers } from './mock/data';
import { nowTime, uid } from './format';

interface AppState {
  items: ChatItem[];
  setItems: Dispatch<SetStateAction<ChatItem[]>>;
  mode: Tier;
  setMode: (t: Tier) => void;
  audit: AuditEvent[];
  logAudit: (e: Omit<AuditEvent, 'id' | 'time'>) => void;
  transfers: Transfer[];
  addTransfer: (t: Transfer) => void;
  alerts: AlertRule[];
  addAlert: (a: AlertRule) => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ChatItem[]>(initialChat);
  const [mode, setMode] = useState<Tier>('T1');
  const [audit, setAudit] = useState<AuditEvent[]>(initialAudit);
  const [transfers, setTransfers] = useState<Transfer[]>(initialTransfers);
  const [alerts, setAlerts] = useState<AlertRule[]>(initialAlerts);

  const logAudit = useCallback((e: Omit<AuditEvent, 'id' | 'time'>) => {
    setAudit((p) => [{ ...e, id: uid(), time: nowTime() }, ...p]);
  }, []);
  const addTransfer = useCallback((t: Transfer) => setTransfers((p) => [t, ...p]), []);
  const addAlert = useCallback((a: AlertRule) => setAlerts((p) => [a, ...p]), []);

  const value = useMemo(
    () => ({ items, setItems, mode, setMode, audit, logAudit, transfers, addTransfer, alerts, addAlert }),
    [items, mode, audit, logAudit, transfers, addTransfer, alerts, addAlert],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside AppStateProvider');
  return v;
}
