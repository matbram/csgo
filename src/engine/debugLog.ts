/** Channel-toggled debug logging.
 *
 *  Each channel:
 *    - is OFF by default,
 *    - when ON, appends compact records to a 200-entry ring buffer,
 *    - does NOT spam `console.log` (the buffer is the source of truth).
 *
 *  When you want to inspect, call `__game.debugLog.dump('shooting')` —
 *  that prints the buffer as a single pretty-formatted block, easy to
 *  copy out of devtools in one paste.
 *
 *  Console examples:
 *    __game.debugLog.enable('shooting')
 *    // ...play, fire some shots...
 *    __game.debugLog.dump('shooting')
 *    __game.debugLog.snapshot('bots')   // returns a string, no auto-print
 *    __game.debugLog.clear('shooting')
 */

export type DebugChannel =
  | 'shooting'
  | 'bots'
  | 'round'
  // Phase 0-6 GOAP redesign diagnostics:
  | 'planner'      // GOAP goal selection + plan expansions per replan
  | 'comms'        // synthesised callouts emit + delivery
  | 'squad'        // squad coordinator (death re-fit, siteClear rotation)
  | 'reactive';    // reactive layer triggers (flash/flinch/molly/panic)

const BUFFER_SIZE = 200;

interface Entry {
  /** Sim or wall ms when the entry was recorded — caller-supplied. */
  t: number;
  label: string;
  payload: Record<string, unknown>;
}

const buffers: Record<DebugChannel, Entry[]> = {
  shooting: [],
  bots: [],
  round: [],
  planner: [],
  comms: [],
  squad: [],
  reactive: [],
};

const enabled = new Set<DebugChannel>();

function record(channel: DebugChannel, label: string, payload: Record<string, unknown>): void {
  if (!enabled.has(channel)) return;
  const buf = buffers[channel];
  buf.push({ t: payload.t as number ?? performance.now(), label, payload });
  if (buf.length > BUFFER_SIZE) buf.shift();
}

function fmt(v: unknown): string {
  if (typeof v === 'number') return Number.isFinite(v) ? v.toFixed(3).replace(/\.?0+$/, '') : String(v);
  if (v && typeof v === 'object') {
    if ('x' in (v as { x?: unknown }) && 'z' in (v as { z?: unknown })) {
      const o = v as { x?: unknown; y?: unknown; z?: unknown };
      return 'y' in o
        ? `(${fmt(o.x)}, ${fmt(o.y)}, ${fmt(o.z)})`
        : `(${fmt(o.x)}, ${fmt(o.z)})`;
    }
    return JSON.stringify(v);
  }
  return String(v);
}

function entryToLine(e: Entry): string {
  const fields = Object.entries(e.payload)
    .filter(([k]) => k !== 't')
    .map(([k, v]) => `${k}=${fmt(v)}`)
    .join(' ');
  return `${e.t.toFixed(0).padStart(7)} ${e.label.padEnd(28)} ${fields}`;
}

const ALL_CHANNELS: DebugChannel[] = [
  'shooting', 'bots', 'round', 'planner', 'comms', 'squad', 'reactive',
];

export const debugLog = {
  shooting(label: string, payload: Record<string, unknown>): void {
    record('shooting', label, payload);
  },
  bots(label: string, payload: Record<string, unknown>): void {
    record('bots', label, payload);
  },
  round(label: string, payload: Record<string, unknown>): void {
    record('round', label, payload);
  },
  planner(label: string, payload: Record<string, unknown>): void {
    record('planner', label, payload);
  },
  comms(label: string, payload: Record<string, unknown>): void {
    record('comms', label, payload);
  },
  squad(label: string, payload: Record<string, unknown>): void {
    record('squad', label, payload);
  },
  reactive(label: string, payload: Record<string, unknown>): void {
    record('reactive', label, payload);
  },
  isEnabled(channel: DebugChannel): boolean {
    return enabled.has(channel);
  },
  enable(channel: DebugChannel): void {
    enabled.add(channel);
    // eslint-disable-next-line no-console
    console.log(`[debug] '${channel}' ENABLED — buffer holds last ${BUFFER_SIZE} entries; call __game.debugLog.dump('${channel}') to print.`);
  },
  /** Convenience: enable every channel in one call. Useful when
   *  capturing a full round for sharing. */
  enableAll(): void {
    for (const c of ALL_CHANNELS) enabled.add(c);
    // eslint-disable-next-line no-console
    console.log(`[debug] all channels ENABLED (${ALL_CHANNELS.join(', ')})`);
  },
  disable(channel: DebugChannel): void {
    enabled.delete(channel);
    // eslint-disable-next-line no-console
    console.log(`[debug] '${channel}' disabled (buffer kept; clear() to drop)`);
  },
  disableAll(): void {
    enabled.clear();
    // eslint-disable-next-line no-console
    console.log(`[debug] all channels disabled`);
  },
  /** Print the channel buffer as a single multi-line block. */
  dump(channel: DebugChannel): void {
    const buf = buffers[channel];
    if (buf.length === 0) {
      // eslint-disable-next-line no-console
      console.log(`[debug] '${channel}' buffer is empty`);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`[debug] '${channel}' (${buf.length} entries)\n${buf.map(entryToLine).join('\n')}`);
  },
  /** Return the buffer as a single string (for copy-paste). */
  snapshot(channel: DebugChannel): string {
    return buffers[channel].map(entryToLine).join('\n');
  },
  /** Return all channels as a single object — used by captureRound to
   *  bundle every buffer into one downloadable JSON. */
  snapshotAll(): Record<DebugChannel, string> {
    const out = {} as Record<DebugChannel, string>;
    for (const c of ALL_CHANNELS) out[c] = buffers[c].map(entryToLine).join('\n');
    return out;
  },
  /** Drop a channel's buffer. */
  clear(channel: DebugChannel): void {
    buffers[channel].length = 0;
  },
  clearAll(): void {
    for (const c of ALL_CHANNELS) buffers[c].length = 0;
  },
  list(): { enabled: DebugChannel[]; sizes: Record<DebugChannel, number> } {
    const sizes = {} as Record<DebugChannel, number>;
    for (const c of ALL_CHANNELS) sizes[c] = buffers[c].length;
    return { enabled: [...enabled], sizes };
  },
};
