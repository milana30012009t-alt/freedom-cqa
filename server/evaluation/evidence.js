// Evidence enrichment: message ids → speaker, original timestamp, relative time, quote.
// Timestamps always come from the transcript itself, never from the model.

export function enrichEvidence(conv, evidence) {
  const byId = new Map(conv.messages.map((m) => [m.id, m]));
  const out = [];
  for (const e of evidence || []) {
    const m = byId.get(e.message_id);
    if (!m) continue;
    if (out.some((x) => x.message_id === m.id)) continue;
    out.push({
      message_id: m.id,
      index: m.index,
      role: e.role || 'supporting',
      speaker: m.speaker,
      ts: m.ts,
      t: m.t,
      t_label: m.t_label,
      quote: e.quote || (m.text.length > 240 ? `${m.text.slice(0, 237)}…` : m.text),
      quote_verified: Boolean(e.quote),
      flags: m.flags.filter((f) => f !== 'encoding_repaired'),
      ...(e.note ? { note: e.note } : {}),
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

export function enrichRange(conv, range) {
  if (!range) return null;
  const byId = new Map(conv.messages.map((m) => [m.id, m]));
  const a = byId.get(range.from);
  const b = byId.get(range.to);
  if (!a || !b) return null;
  return { from: a.id, to: b.id, from_label: a.t_label, to_label: b.t_label, count: Math.abs(b.index - a.index) + 1 };
}
