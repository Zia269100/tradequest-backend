import type { WebSocket } from 'ws';
import { logger } from '../logger';

export type QuoteMessage = {
  type: 'quote';
  symbol: string;
  price: number;
  ts: string;
};

const clients = new Set<WebSocket>();

export function marketHubAdd(ws: WebSocket): void {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
}

export function broadcastQuote(symbol: string, price: number, ts: Date): void {
  const payload: QuoteMessage = {
    type: 'quote',
    symbol,
    price,
    ts: ts.toISOString(),
  };
  const raw = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(raw);
      } catch (e) {
        logger.warn({ err: e }, 'ws send failed');
        clients.delete(ws);
      }
    }
  }
}
