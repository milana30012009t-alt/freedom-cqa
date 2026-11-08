// Tiny global state with change events. Only light per-viewer preferences are persisted
// (role, display name, audio sync calibration) — wrapped in try/catch as storage may be blocked.

const listeners = new Set();

function load(key, fallback) {
  try {
    const v = localStorage.getItem(`cqa:${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(`cqa:${key}`, JSON.stringify(value));
  } catch { /* storage unavailable — keep in memory */ }
}

export const store = {
  state: {
    role: load('role', 'specialist'),
    userName: load('userName', ''),
    system: null,
    appealsOpen: 0,
  },
  set(patch) {
    Object.assign(this.state, patch);
    if ('role' in patch) save('role', patch.role);
    if ('userName' in patch) save('userName', patch.userName);
    for (const l of listeners) l(this.state, patch);
  },
  on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  pref(key, fallback) {
    return load(`pref:${key}`, fallback);
  },
  setPref(key, value) {
    save(`pref:${key}`, value);
  },
};
