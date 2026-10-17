import type { Route } from '../types';
import { fmtBDT, fmtMoney } from '../format';

export default function RouteCard({ routes, bestId }: { routes: Route[]; bestId: string }) {
  return (
    <div className="card routes">
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Route</th>
              <th scope="col" className="num">Fee</th>
              <th scope="col" className="num">Arrives</th>
              <th scope="col" className="num">They receive</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((r) => (
              <tr key={r.id} className={r.id === bestId && r.quotable ? 'best' : ''}>
                <th scope="row">
                  {r.name}
                  {r.id === bestId && r.quotable && <span className="flag">Lowest total cost</span>}
                  <small>{r.note}</small>
                </th>
                <td className="num">{fmtBDT(r.feeBDT)}<small>{r.spreadPct.toFixed(1)}% FX margin</small></td>
                <td className="num">{r.etaDays} {r.etaDays === 1 ? 'day' : 'days'}</td>
                <td className="num strong">{r.net == null ? 'No quote' : fmtMoney(r.net, r.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fine">Sample data from the project dataset. Total cost = fee plus the hidden FX margin.</p>
    </div>
  );
}
