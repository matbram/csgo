/** Channel-toggled debug logging. Off by default — flip a channel on
 *  from the browser dev console (`__game.debugLog.enable('shooting')`)
 *  to start streaming structured records. Each channel is independent
 *  so you can turn on shooting without flooding the console with bot
 *  decision logs.
 *
 *  Records are emitted via `console.log` with a tagged prefix so they
 *  can be grepped easily. We deliberately go through `console.log`
 *  rather than the events bus so the logs survive a page reload and
 *  can be copy-pasted out of devtools.
 *
 *  Usage from gameplay code:
 *    import { debugLog } from '../engine/debugLog';
 *    debugLog.shooting('fire', { origin, dir, spray, inacc });
 *
 *  Usage from the console:
 *    __game.debugLog.enable('shooting')   // flip on
 *    __game.debugLog.enable('bots')
 *    __game.debugLog.disable('shooting')
 *    __game.debugLog.list()                // see what's enabled */

export type DebugChannel = 'shooting' | 'bots' | 'round';

const enabled = new Set<DebugChannel>();

function emit(channel: DebugChannel, label: string, payload: Record<string, unknown>): void {
  if (!enabled.has(channel)) return;
  // eslint-disable-next-line no-console
  console.log(`[${channel}] ${label}`, payload);
}

export const debugLog = {
  shooting(label: string, payload: Record<string, unknown>): void {
    emit('shooting', label, payload);
  },
  bots(label: string, payload: Record<string, unknown>): void {
    emit('bots', label, payload);
  },
  round(label: string, payload: Record<string, unknown>): void {
    emit('round', label, payload);
  },
  enable(channel: DebugChannel): void {
    enabled.add(channel);
    // eslint-disable-next-line no-console
    console.log(`[debug] '${channel}' channel ENABLED`);
  },
  disable(channel: DebugChannel): void {
    enabled.delete(channel);
    // eslint-disable-next-line no-console
    console.log(`[debug] '${channel}' channel disabled`);
  },
  list(): DebugChannel[] {
    return [...enabled];
  },
  isEnabled(channel: DebugChannel): boolean {
    return enabled.has(channel);
  },
};
